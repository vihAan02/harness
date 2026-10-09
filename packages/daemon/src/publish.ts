// The publish gate (D-114, TH-24): everything harnessd pushes goes to a public repository, so before any push of a
// task branch it scans every commit the push would send, not just the final tree, since a secret added in one commit
// and deleted in the next is still published. Plus the commit messages and the PR's text. Two outcomes:
// - blocked: a denied path (CI workflows, harness state, logs, keys, env files), a file over 1 MB, or text that
//   looks like a credential or equals a secret harnessd holds. Nothing is pushed; the human sees why.
// - held: a dependency change (lockfile, manifests' dependencies, .npmrc), or a change to how Git treats files
//   (.gitattributes, .gitmodules). It needs the human's approval, like any other publish, but the approval names it.
// The scan runs on the main repository by commit id; it reads objects, never a worktree.
import { createHash } from 'node:crypto';
import { git } from './git.ts';

export type GateFinding = { rule: string; commit?: string; path?: string };
export type GateResult = { commits: string[]; blocked: GateFinding[]; held: GateFinding[] };

const MAX_BLOB = 1024 * 1024;
const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** Paths an agent's task never publishes (TH-24): CI can read repository secrets, and these hold state or keys. */
const DENIED_PATHS: [string, RegExp][] = [
  ['ci_workflow', /^\.github\//],
  ['harness_state', /(^|\/)\.harness(\/|$)/],
  ['log_file', /\.log$/],
  ['env_file', /(^|\/)\.env(?!\.example$)(\.[^/]*)?$/],
  ['key_file', /\.(pem|key|p12|pfx)$|(^|\/)id_(rsa|ed25519|ecdsa)(\.pub)?$/],
];
/** Text that looks like a credential (D-64, TH-24). Matched on added lines only, so existing test fixtures don't trip it. */
const SECRET_PATTERNS: [string, RegExp][] = [
  ['openrouter_key', /sk-or-[A-Za-z0-9-]{20,}/],
  ['anthropic_key', /sk-ant-[A-Za-z0-9_-]{20,}/],
  ['github_token', /\bgh[opusr]_[A-Za-z0-9]{36,}/],
  ['github_pat', /\bgithub_pat_[A-Za-z0-9_]{20,}/],
  ['aws_key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private_key', /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
];
const DEPENDENCY_FILES = /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|\.npmrc|yarn\.lock|pnpm-lock\.yaml)$/;
/** Files that change how Git reads others (`-diff` hides a file's content from a diff; a submodule points anywhere). */
const GIT_BEHAVIOUR_FILES = /(^|\/)(\.gitattributes|\.gitmodules)$/;
/** A patch's every added line, whatever Git would otherwise do with the file: binary and `-diff` content as text, no
 * repository-configured conversion or external diff (TH-24; #99's review). */
const AS_TEXT = ['--unified=0', '--no-color', '--text', '--no-textconv', '--no-ext-diff'];
const DEPENDENCY_KEYS = /^[+-]\s*"(dependencies|devDependencies|optionalDependencies|peerDependencies|overrides|resolutions|bundleDependencies|scripts)"\s*:/;

/** What a text contains that it shouldn't: credential shapes, or any of `secrets` (values harnessd holds, ≥ 8 characters). */
export function secretsIn(text: string, secrets: string[]): string[] {
  const hits = SECRET_PATTERNS.filter(([, re]) => re.test(text)).map(([rule]) => rule);
  if (secrets.some((s) => s.length >= 8 && text.includes(s))) hits.push('held_secret');
  return hits;
}

export function deniedPath(path: string): string | null {
  return DENIED_PATHS.find(([, re]) => re.test(path))?.[0] ?? null;
}

/**
 * Scans what pushing `head` would publish: the commits not on `base` and not already pushed (`pushed`), each one's
 * added or modified paths and added lines, its message, and the PR's text. A merge commit counts only for what differs
 * from every parent (a conflict's resolution); what it brought from the base is already public.
 */
export async function scanPublish(repo: string, o: { head: string; base: string; pushed: string | null; prText: string; secrets: string[] }): Promise<GateResult> {
  for (const s of [o.head, o.base, ...(o.pushed ? [o.pushed] : [])]) if (!SHA.test(s)) throw new Error(`not a commit id: ${s}`);
  const range = await git(repo, 'rev-list', o.head, '--not', o.base, ...(o.pushed ? [o.pushed] : []));
  const commits = range ? range.split('\n') : [];
  const blocked: GateFinding[] = [];
  const held: GateFinding[] = [];
  const add = (into: GateFinding[], f: GateFinding) => { if (!into.some((x) => x.rule === f.rule && x.commit === f.commit && x.path === f.path)) into.push(f); };
  for (const commit of commits) {
    const parents = (await git(repo, 'rev-list', '--parents', '-n', '1', commit)).split(' ').slice(1);
    for (const rule of secretsIn(await git(repo, 'log', '-1', '--format=%B', commit), o.secrets)) add(blocked, { rule: `message:${rule}`, commit });
    const merge = parents.length > 1;
    const paths = (merge
      ? await git(repo, 'diff-tree', '--cc', '--no-commit-id', '--name-only', '-z', commit)
      : await git(repo, 'diff-tree', '-r', '--root', '--no-commit-id', '--no-renames', '--name-only', '--diff-filter=AMT', '-z', commit))
      .split('\0').filter(Boolean);
    for (const path of paths) {
      const denied = deniedPath(path);
      if (denied) { add(blocked, { rule: denied, commit, path }); continue; }
      const size = Number(await git(repo, 'cat-file', '-s', `${commit}:${path}`).catch(() => '0'));
      if (size > MAX_BLOB) { add(blocked, { rule: 'large_file', commit, path }); continue; }
      const patch = merge
        ? await git(repo, 'diff', ...AS_TEXT, `${parents[0]}`, commit, '--', path)
        : await git(repo, 'show', '--format=', ...AS_TEXT, commit, '--', path);
      const added = patch.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++')).join('\n');
      for (const rule of secretsIn(added, o.secrets)) add(blocked, { rule: `secret:${rule}`, commit, path });
      if (DEPENDENCY_FILES.test(path) || (/(^|\/)package\.json$/.test(path) && patch.split('\n').some((l) => DEPENDENCY_KEYS.test(l)))) {
        add(held, { rule: 'dependency_change', commit, path });
      }
      if (GIT_BEHAVIOUR_FILES.test(path)) add(held, { rule: 'git_attributes_change', commit, path });
    }
  }
  for (const rule of secretsIn(o.prText, o.secrets)) add(blocked, { rule: `pr_text:${rule}` });
  return { commits, blocked, held };
}

/** What a publish approval is bound to: the exact head and the exact PR text (D-114). */
export function publishHash(head: string, prText: string): string {
  return createHash('sha256').update(JSON.stringify({ v: 1, kind: 'publish', head, prText })).digest('hex');
}
