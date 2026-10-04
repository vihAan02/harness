// Read confinement (0B item 7; D-61, D-98): the policy's decisions, its static deny list, how the Claude
// adapter compiles it, and the PreToolUse check that catches what static rules can't name.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { claudeHooks, compileClaudePermissions, deniedEntries, readAllowed, realish, type ReadPolicy } from '../src/index.ts';
import { readTargets } from '../src/claude/hooks.ts';

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'readpolicy-')));
after(() => fs.rmSync(root, { recursive: true, force: true }));
const H = path.join(root, 'home');
const mk = (p: string, content?: string) => {
  const abs = path.join(H, p);
  if (content === undefined) fs.mkdirSync(abs, { recursive: true });
  else { fs.mkdirSync(path.dirname(abs), { recursive: true }); fs.writeFileSync(abs, content); }
  return abs;
};
// A home with the human's files, harness state with this task's worktree and a sibling, and the main checkout.
const wt = mk('.harness/worktrees/prj/T-1');
mk('.harness/worktrees/prj/T-2/sib.txt', 'sibling');
mk('.harness/token', 'token');
mk('Documents/harness-canary.txt', 'canary');
mk('.ssh/id_rsa', 'key');
const gitDir = mk('code/repo/.git');
mk('code/repo/src/main.ts', 'main');
mk('code/other/x.ts', 'other');
mk('notes (1).txt', 'odd name');
fs.symlinkSync(path.join(H, 'Documents/harness-canary.txt'), path.join(wt, 'link'));
// Symlinks in home: one to the agent's own worktree, one out of home. A deny rule for either would deny
// wherever it points (the vendor resolves rules), so the static list skips them (review finding).
fs.symlinkSync(wt, path.join(H, 'link-to-worktree'));
fs.symlinkSync(os.tmpdir(), path.join(H, 'link-out'));
const policy: ReadPolicy = { denyRoots: [H], allowRoots: [wt, gitDir] };

test('realish resolves symlinks, and paths that don\'t exist yet through their nearest existing ancestor', () => {
  assert.equal(realish(path.join(wt, 'link')), path.join(H, 'Documents/harness-canary.txt'));
  assert.equal(realish(path.join(wt, 'new/deep/file.ts')), path.join(wt, 'new/deep/file.ts'));
  assert.equal(realish(path.join(wt, 'link-missing/../x')), path.join(wt, 'x'));
});

const caseInsensitive = fs.existsSync(path.join(H, 'DOCUMENTS'));
test('a path spelled in another case is checked as the file it opens (case-insensitive file systems)', { skip: !caseInsensitive && 'case-sensitive file system' }, () => {
  const shouted = path.join(H.toUpperCase(), 'DOCUMENTS', 'HARNESS-CANARY.TXT');
  assert.equal(realish(shouted), path.join(H, 'Documents', 'harness-canary.txt'));
  assert.equal(readAllowed(policy, shouted, wt), false);
  assert.equal(readAllowed(policy, path.join(H, 'Documents', 'NOT-THERE-YET').toUpperCase(), wt), false, 'nor a file that doesn\'t exist yet');
  assert.equal(readAllowed(policy, path.join(wt, 'SRC', 'A.TS'), wt), true, 'the worktree in another case is still the worktree');
});

test('other spellings of a denied path are the same path: //, /./, .., and Unicode normalization (the reviewer\'s file-tool lens)', () => {
  const canary = path.join(H, 'Documents/harness-canary.txt');
  for (const p of [canary.replace('/Documents/', '//Documents/'), canary.replace('/Documents/', '/./Documents/'),
    path.join(wt, '..', '..', '..', '..', 'Documents', 'harness-canary.txt'), `${wt}/../T-2/sib.txt`, `${path.join(H, 'Documents')}/`]) {
    assert.equal(readAllowed(policy, p, wt), false, p);
  }
  // A directory whose on-disk name is NFC, asked for in NFD (APFS treats them as the same name).
  const nfc = mk('Documents/Caf\u00e9-notes/secret.txt', 'secret'); // inside an entry already denied, so the static list doesn't change
  const nfd = nfc.replace('Caf\u00e9', 'Cafe\u0301');
  if (fs.existsSync(nfd)) assert.equal(readAllowed(policy, nfd, wt), false, 'the NFD spelling of a denied file');
  assert.equal(readAllowed(policy, nfc, wt), false);
});

test('reads: the worktree and the shared .git yes; the rest of home no; outside home yes (D-98)', () => {
  const can = (p: string) => readAllowed(policy, p, wt);
  assert.equal(can('src/a.ts'), true, 'relative, in the worktree');
  assert.equal(can(path.join(gitDir, 'HEAD')), true, 'the shared .git, for read-only Git');
  assert.equal(can(path.join(H, 'Documents/harness-canary.txt')), false, 'T-1\'s canary');
  assert.equal(can(path.join(H, '.ssh/id_rsa')), false);
  assert.equal(can(path.join(H, '.harness/token')), false, 'harness state');
  assert.equal(can(path.join(H, '.harness/worktrees/prj/T-2/sib.txt')), false, 'a sibling worktree');
  assert.equal(can(path.join(H, '.harness/worktrees/prj/T-9/later.txt')), false, 'a sibling that doesn\'t exist yet');
  assert.equal(can(path.join(H, 'code/repo/src/main.ts')), false, 'the main checkout');
  assert.equal(can('../T-2/sib.txt'), false, 'climbing out');
  assert.equal(can('link'), false, 'a symlink in the worktree pointing out');
  assert.equal(can(`${wt}-evil/x`), false, 'a sibling whose name starts with the worktree\'s');
  assert.equal(can(H), false, 'the home directory itself');
  assert.equal(can('/usr/bin/env'), true, 'system paths stay readable');
  assert.equal(can(os.tmpdir()), true);
});

test('the static deny list: every entry not on the way to an allowed root, no symlinks, nothing allowed', () => {
  const rel = (ps: string[]) => ps.map((p) => path.relative(H, p));
  const full = deniedEntries(policy);
  assert.equal(full.coarse, false);
  assert.deepEqual(rel(full.entries), [
    '.harness/token', '.harness/worktrees/prj/T-2', '.ssh', 'Documents', 'code/other', 'code/repo/src', 'notes (1).txt',
  ]);
  // A deny root with nothing allowed inside is denied whole; one inside an allowed root isn't denied at all.
  assert.deepEqual(deniedEntries({ denyRoots: [path.join(H, 'Documents')], allowRoots: [wt] }).entries, [path.join(H, 'Documents')]);
  assert.deepEqual(deniedEntries({ denyRoots: [path.join(wt, 'src')], allowRoots: [wt] }).entries, []);
  // Over budget: only the top level, the rest left to the call-time check and the sandbox; and nothing if even that is too big.
  const coarse = deniedEntries(policy, 600);
  assert.deepEqual([coarse.coarse, rel(coarse.entries)], [true, ['.ssh', 'Documents', 'notes (1).txt']]);
  assert.deepEqual(deniedEntries(policy, 10), { entries: [], coarse: true });
});

test('a directory on the way that can\'t be listed refuses the session, rather than leaving its entries without rules', { skip: process.getuid?.() === 0 && 'root can list anything' }, () => {
  const locked = mk('locked');
  const inner = mk('locked/wt');
  mk('locked/secret.txt', 'secret');
  fs.chmodSync(locked, 0o311); // traversable, not listable
  try {
    assert.throws(() => deniedEntries({ denyRoots: [H], allowRoots: [inner] }), /can't list .*locked \(EACCES\)/);
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(locked, { recursive: true });
  }
});

test('compilePermissions: a Read deny rule per entry, sandbox denyRead/allowRead from the policy; without one, unchanged', () => {
  const denied = deniedEntries(policy).entries;
  const linked = { ...policy, allowLinks: [path.join(H, '.nvm/current')] };
  const p = compileClaudePermissions({ worktree: wt, gitCommonDir: gitDir, ports: null, tools: [], readPolicy: linked }, denied);
  const deny = (p.settings as any).permissions.deny as string[];
  assert.ok(deny.includes(`Read(/${H}/Documents)`) && deny.includes(`Read(/${H}/Documents/**)`));
  assert.ok(deny.includes(`Read(/${H}/.harness/worktrees/prj/T-2/**)`));
  assert.ok(!deny.some((r) => r.includes('notes (1)')), 'a name a rule can\'t spell literally is left to the hook and the sandbox');
  assert.ok(!deny.some((r) => r.includes('/T-1') || r.includes('/.git')), 'nothing allowed is denied');
  const fsb = (p.sandbox as any).filesystem;
  assert.deepEqual([fsb.denyRead, fsb.allowRead], [[H], [wt, gitDir, path.join(H, '.nvm/current')]], 'a PATH symlink re-opened for the shell only');
  assert.ok(fsb.denyWrite.length > 0, 'the shared .git stays write-denied (D-60)');
  const plain = compileClaudePermissions({ worktree: wt, gitCommonDir: gitDir, ports: null, tools: [] });
  assert.equal((plain.settings as any).permissions.deny, undefined);
  assert.equal((plain.sandbox as any).filesystem.denyRead, undefined);
  assert.throws(() => compileClaudePermissions({ worktree: wt, gitCommonDir: gitDir, ports: null, tools: [], readPolicy: { denyRoots: ['home'], allowRoots: [] } }), /absolute/);
});

test('readTargets: Read\'s file, Grep\'s and Glob\'s root (default: the cwd), and where a Glob pattern starts', () => {
  assert.deepEqual(readTargets({ tool_name: 'Read', tool_input: { file_path: '/x/y' } }, wt), ['/x/y']);
  assert.deepEqual(readTargets({ tool_name: 'Grep', tool_input: { pattern: 'a' } }, wt), [wt]);
  assert.deepEqual(readTargets({ tool_name: 'Glob', tool_input: { pattern: 'src/**/*.ts' } }, wt), [wt, path.join(wt, 'src')]);
  assert.deepEqual(readTargets({ tool_name: 'Glob', tool_input: { pattern: '../../../../Documents/*' } }, wt), [wt, path.join(H, 'Documents')]);
  assert.deepEqual(readTargets({ tool_name: 'Glob', tool_input: { pattern: `${H}/Documents/*.txt`, path: '/tmp' } }, wt), ['/tmp', path.join(H, 'Documents')]);
  assert.deepEqual(readTargets({ tool_name: 'Bash', tool_input: { command: 'cat x' } }, wt), []);
});

test('PreToolUse denies reads outside the policy at call time, including paths no static rule names (F-100)', async () => {
  const pre = claudeHooks({ worktree: wt, readPolicy: policy }, { observe: () => {} }).PreToolUse![0]!;
  const call = async (tool: string, input: Record<string, unknown>) =>
    (await pre.hooks[0]!({ tool_name: tool, tool_input: input } as never, undefined, { signal: new AbortController().signal })) as Record<string, any>;
  const decision = async (tool: string, input: Record<string, unknown>) => (await call(tool, input)).hookSpecificOutput?.permissionDecision ?? 'allow';
  assert.equal(await decision('Read', { file_path: path.join(wt, 'src/a.ts') }), 'allow');
  assert.equal(await decision('Grep', { pattern: 'x' }), 'allow');
  assert.equal(await decision('Glob', { pattern: 'src/*' }), 'allow');
  assert.equal(await decision('Read', { file_path: path.join(H, 'Documents/harness-canary.txt') }), 'deny');
  assert.equal(await decision('Read', { file_path: path.join(H, '.harness/worktrees/prj/T-3/late.txt') }), 'deny', 'a sibling created later');
  assert.equal(await decision('Read', { file_path: path.join(wt, 'link') }), 'deny', 'a symlink out');
  assert.equal(await decision('Grep', { pattern: 'canary', path: H }), 'deny', 'searching from an ancestor');
  assert.equal(await decision('Glob', { pattern: '../../*' }), 'deny', 'a pattern climbing out');
  // A leading ~ is expanded by the CLI after this hook (Grep's and Glob's path), so it's refused outright (review finding).
  for (const [tool, input] of [['Grep', { pattern: 'x', path: '~/.harness/worktrees/prj/T-3' }], ['Grep', { pattern: 'x', path: '~' }],
    ['Glob', { pattern: '*', path: '~/new' }], ['Glob', { pattern: '~/Documents/*' }], ['Read', { file_path: '~/notes.txt' }], ['Grep', { pattern: 'x', path: ' ~/x' }]] as const) {
    assert.equal(await decision(tool, input), 'deny', `${tool} ${JSON.stringify(input)}`);
  }
  assert.equal(await decision('Grep', { pattern: '~not-a-path' }), 'allow', 'a ~ in Grep\'s search pattern is just text');
  const reason = (await call('Read', { file_path: path.join(H, '.ssh/id_rsa') })).hookSpecificOutput.permissionDecisionReason as string;
  assert.match(reason, /confines reads to this task's worktree/);
  // Without a read policy (a vendor test, the 0A behaviour) reads aren't checked here.
  const open = claudeHooks({ worktree: wt }, { observe: () => {} }).PreToolUse![0]!;
  assert.deepEqual(await open.hooks[0]!({ tool_name: 'Read', tool_input: { file_path: path.join(H, '.ssh/id_rsa') } } as never, undefined, { signal: new AbortController().signal }), {});
});
