// Q3 + Q4: which edits and reads can we observe, and through what?
// Ground truth = filesystem diff. Observed = in-process hook payloads + SDK stream.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture } from '../lib/fixture.ts';
import { hardenedOptions, startRun, recordingHooks, sleep, Inbox, type HookRecord } from '../lib/session.ts';

const f = makeFixture('e03');
const W = f.wtA;
const files: Record<string, string> = {};
for (const n of ['e-edit', 'e-sed', 'e-mv-src', 'e-rm', 'e-cp-src', 'e-script', 'e-tee', 'e-nb']) files[n] = `${W}/cap/${n}.txt`;
for (const n of ['r-read', 'r-offset', 'r-twice', 'r-grep-content', 'r-grep-files', 'r-glob', 'r-cat', 'r-sed', 'r-grep-r', 'r-python', 'r-mention', 'r-subagent']) files[n] = `${W}/rd/${n}.txt`;
for (const [n, p] of Object.entries(files)) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, `content of ${n}\nNEEDLE-${n}\n`); }
fs.writeFileSync(files['e-nb'].replace('.txt', '.ipynb'), JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
fs.writeFileSync(`${W}/cap/writer.sh`, `#!/bin/sh\necho via-script > '${W}/cap/e-script-out.txt'\n`);

function snapshot(dir: string) {
  const out: Record<string, string> = {};
  const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.name === '.git') continue; if (e.isDirectory()) walk(p); else out[path.relative(W, p)] = crypto.createHash('sha1').update(fs.readFileSync(p)).digest('hex').slice(0, 8); } };
  walk(dir); return out;
}
const before = snapshot(W);

const subTask = ['Subagent task.', `#STEP Read {"file_path":"${files['r-subagent']}"}`, `#STEP Write {"file_path":"${W}/cap/e-subagent-new.txt","content":"by subagent\\n"}`, '#STEP TEXT sub done'].join('\n');
const S = (tool: string, input: any) => `#STEP ${tool} ${JSON.stringify(input)}`;
const steps = [
  // edits
  S('Write', { file_path: `${W}/cap/e-write-new.txt`, content: 'new\n' }),
  S('Read', { file_path: files['e-edit'] }), S('Edit', { file_path: files['e-edit'], old_string: 'content', new_string: 'EDITED' }),
  S('Read', { file_path: files['e-nb'].replace('.txt', '.ipynb') }), S('NotebookEdit', { notebook_path: files['e-nb'].replace('.txt', '.ipynb'), new_source: 'print(1)', cell_type: 'code', edit_mode: 'insert' }),
  S('Bash', { command: `echo hi > cap/e-echo-new.txt` }),
  S('Bash', { command: `sed -i '' 's/content/SEDDED/' cap/e-sed.txt` }),
  S('Bash', { command: `python3 -c "open('cap/e-python-new.txt','w').write('x')"` }),
  S('Bash', { command: 'mv cap/e-mv-src.txt cap/e-mv-dst.txt' }),
  S('Bash', { command: 'rm cap/e-rm.txt' }),
  S('Bash', { command: 'cp cap/e-cp-src.txt cap/e-cp-dst.txt' }),
  S('Bash', { command: 'sh cap/writer.sh' }),
  S('Bash', { command: 'echo teed | tee cap/e-tee.txt > /dev/null' }),
  S('Task', { description: 'sub', prompt: subTask, subagent_type: 'general-purpose' }),
  // reads
  S('Read', { file_path: files['r-read'] }),
  S('Read', { file_path: files['r-offset'], offset: 2, limit: 1 }),
  S('Read', { file_path: files['r-twice'] }), S('Read', { file_path: files['r-twice'] }),
  S('Grep', { pattern: 'NEEDLE-r-grep-content', path: `${W}/rd`, output_mode: 'content' }),
  S('Grep', { pattern: 'NEEDLE-r-grep-files', path: `${W}/rd`, output_mode: 'files_with_matches' }),
  S('Glob', { pattern: 'rd/r-glob*' }),
  S('Bash', { command: 'cat rd/r-cat.txt' }),
  S('Bash', { command: "sed -n '1p' rd/r-sed.txt" }),
  S('Bash', { command: 'grep -r NEEDLE-r-grep-r rd' }),
  S('Bash', { command: `python3 -c "print(open('rd/r-python.txt').read())"` }),
  '#STEP TEXT turn one done',
];
const mock = await startMock({ rawDir: `${f.root}/raw` });
const hooks: HookRecord[] = [];
const inbox = new Inbox();
inbox.push(['Capture test.', ...steps].join('\n'), { origin: { kind: 'human' } } as any);
let results = 0;
const o = hardenedOptions({ cwd: W, mock, configDir: f.configA, hooks: recordingHooks(hooks) });
o.allowedTools = [...(o.allowedTools as string[]), 'NotebookEdit', 'Task'];
const { run, done } = startRun(inbox, o, (m: any) => {
  if (m.type === 'result') {
    results++;
    // Turn 2: a human message with an @-mention (no client_composed), to see whether the expansion read is observable.
    if (results === 1) inbox.push(`Second turn: see @${files['r-mention']}\n#STEP TEXT ok`, { origin: { kind: 'human' } } as any);
    if (results === 2) inbox.close();
  }
});
await Promise.race([done, sleep(120000)]);
await mock.close();
const after = snapshot(W);
const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]).sort();

const post = hooks.filter((h) => h.event === 'PostToolUse');
const summarizePost = post.map((h) => ({
  tool: h.tool, agent_id: h.raw.agent_id ? 'yes' : undefined,
  input: Object.fromEntries(Object.entries(h.input ?? {}).map(([k, v]) => [k, typeof v === 'string' ? String(v).slice(0, 90) : v])),
  responseKeys: h.response && typeof h.response === 'object' ? Object.keys(h.response) : typeof h.response,
  responseExtract: (() => {
    const r: any = h.response; if (!r || typeof r !== 'object') return undefined;
    const pick: any = {};
    for (const k of Object.keys(r)) if (!['stdout', 'stderr', 'content', 'originalFile', 'structuredPatch'].includes(k)) pick[k] = typeof r[k] === 'string' ? r[k].slice(0, 160) : r[k];
    if (r.file) pick.file = { filePath: r.file.filePath, numLines: r.file.numLines, contentLen: r.file.content?.length };
    return JSON.stringify(pick).slice(0, 400);
  })(),
}));
const otherHooks = hooks.filter((h) => !['PostToolUse', 'PreToolUse'].includes(h.event)).map((h) => `${h.event}${h.raw.agent_id ? '(sub)' : ''}:${JSON.stringify(Object.fromEntries(Object.entries(h.raw).filter(([k]) => !['session_id', 'transcript_path', 'cwd', 'hook_event_name', 'prompt_id', 'permission_mode', 'effort'].includes(k)))).slice(0, 200)}`);
fs.writeFileSync(`${f.root}/result.json`, JSON.stringify({ changed, post: summarizePost, otherHooks, error: run.error }, null, 2));
console.log('ERROR:', run.error ?? '-', 'results:', results);
console.log('\nGROUND TRUTH changed files:', changed.join(', '));
console.log('\nPostToolUse payloads:');
for (const p of summarizePost) console.log(`- ${p.tool}${p.agent_id ? ' [subagent]' : ''} input=${JSON.stringify(p.input).slice(0, 150)}\n    responseKeys=${JSON.stringify(p.responseKeys)}\n    extract=${p.responseExtract}`);
console.log('\nOther hook events:'); for (const h of otherHooks) console.log('-', h);
