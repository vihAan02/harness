// Q5 follow-up: file tools on EXISTING files outside the worktree after a Read
// (removes the "read first" confound), protected paths, and read-only git under
// the shared-.git write-deny.
import fs from 'node:fs';
import { startMock } from '../lib/mock-api.ts';
import { makeFixture, git } from '../lib/fixture.ts';
import { hardenedOptions, startRun, sleep } from '../lib/session.ts';

async function config(name: string, scoped: boolean) {
  const f = makeFixture(`e05b-${name}`);
  fs.writeFileSync(`${f.outside}/nb.ipynb`, JSON.stringify({ cells: [], metadata: {}, nbformat: 4, nbformat_minor: 5 }));
  const has = (p: string, s: string) => { try { return fs.readFileSync(p, 'utf8').includes(s); } catch { return false; } };
  const T: { id: string; steps: string[]; check: () => boolean }[] = [];
  const rw = (id: string, p: string, old: string) => {
    T.push({ id: `${id}/Read+Write`, steps: [`#STEP Read ${JSON.stringify({ file_path: p })}`, `#STEP Write ${JSON.stringify({ file_path: p, content: `ESC-${id}-W\n` })}`], check: () => has(p, `ESC-${id}-W`) });
  };
  rw('sibling', `${f.wtB}/src/util.ts`, 'pad');
  rw('main-checkout', `${f.repo}/src/util.ts`, 'pad');
  rw('own-claude-settings', `${f.wtA}/.claude/settings.json`, 'hooks');
  rw('own-mcp-json', `${f.wtA}/.mcp.json`, 'mcpServers');
  rw('git-config', `${f.gitCommonDir}/config`, 'core');
  rw('own-dotgit-file', `${f.wtA}/.git`, 'gitdir');
  T.push({ id: 'sibling/Read+Edit', steps: [`#STEP Read ${JSON.stringify({ file_path: `${f.wtB}/src/api.ts` })}`, `#STEP Edit ${JSON.stringify({ file_path: `${f.wtB}/src/api.ts`, old_string: 'login', new_string: 'ESC_EDIT_login' })}`], check: () => has(`${f.wtB}/src/api.ts`, 'ESC_EDIT') });
  T.push({ id: 'outside/Read+NotebookEdit', steps: [`#STEP Read ${JSON.stringify({ file_path: `${f.outside}/nb.ipynb` })}`, `#STEP NotebookEdit ${JSON.stringify({ notebook_path: `${f.outside}/nb.ipynb`, new_source: 'ESC-NB', cell_type: 'code', edit_mode: 'insert' })}`], check: () => has(`${f.outside}/nb.ipynb`, 'ESC-NB') });
  // Read-only git must still work under the shared-.git write-deny.
  const gitCmds = ['git status --porcelain && echo STATUS-OK', 'git diff --stat && echo DIFF-OK', 'git log --oneline -1 && echo LOG-OK', 'git merge-base HEAD main && echo MB-OK', 'git rev-parse --abbrev-ref HEAD && echo REV-OK', 'git fetch . main:refs/remotes/x/main 2>&1; echo FETCH-RC=$?', 'git stash 2>&1; echo STASH-RC=$?'];
  const steps = [...T.flatMap((t) => t.steps), ...gitCmds.map((c) => `#STEP Bash ${JSON.stringify({ command: c })}`), '#STEP TEXT done'];
  const mock = await startMock();
  const gd = f.gitCommonDir;
  const o = hardenedOptions({ cwd: f.wtA, mock, configDir: f.configA,
    sandboxFs: scoped ? { denyWrite: [`${gd}/config`, `${gd}/hooks`, `${gd}/refs`, `${gd}/objects`, `${gd}/packed-refs`, `${gd}/info`, `${gd}/worktrees`, `${gd}/HEAD`, `${gd}/index`, `${gd}/logs`] } : undefined });
  if (scoped) {
    o.allowedTools = ['Read', 'Grep', 'Glob', 'Bash', `Edit(/${f.wtA}/**)`, `Write(/${f.wtA}/**)`];
    (o.settings as any).permissions = { allow: [`Edit(/${f.wtA}/**)`], deny: [] };
  }
  const { run, done } = startRun(['rw test', ...steps].join('\n'), o);
  await Promise.race([done, sleep(90000)]);
  await mock.close();
  const results = run.messages.filter((m: any) => m.type === 'user' && Array.isArray(m.message.content) && m.message.content[0]?.type === 'tool_result')
    .map((m: any) => { const c = m.message.content[0]; return { err: !!c.is_error, text: (typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).replace(/\n/g, ' ').slice(0, 170) }; });
  console.log(`\n===== ${name} error=${run.error ?? '-'}`);
  let k = 0;
  for (const t of T) { const rs = results.slice(k, k + t.steps.length); k += t.steps.length; console.log(`${t.check() ? 'WROTE  ' : 'blocked'} ${t.id.padEnd(28)} | ${rs.map((r) => `${r.err ? 'ERR' : 'ok'}: ${r.text.slice(0, 120)}`).join(' || ')}`); }
  for (const c of gitCmds) { const r = results[k++]; console.log(`git: ${c.padEnd(48)} -> ${r?.err ? 'ERR' : 'ok'} ${r?.text}`); }
  console.log('ref b unchanged:', git(f.repo, 'rev-parse', 'harness/task/b') === git(f.repo, 'rev-parse', 'main'));
}
await config('c1-sandbox-only', false);
await config('c2-scoped-rules', true);
