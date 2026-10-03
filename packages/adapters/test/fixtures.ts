// A repo with one task worktree, a config dir and a scripted mock API, for running real Claude Code sessions.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { HarnessTool, Observation, SessionSpec } from '../src/adapter.ts';
import { DUMMY_KEY, startMock, type Mock } from './mock-api.ts';

export function gitIn(cwd: string, ...args: string[]): string {
  return execFileSync('git', ['-c', 'core.hooksPath=/dev/null', ...args], {
    cwd, env: { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
  }).toString().trim();
}

export type Fixture = {
  root: string; repo: string; worktree: string; gitCommonDir: string; outside: string; mock: Mock;
  spec: (over?: Partial<SessionSpec>) => SessionSpec; cleanup: () => Promise<void>;
};

export async function fixture(): Promise<Fixture> {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-adapter-')));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'types.ts'), 'export type User = { id: string };\n');
  gitIn(root, 'init', '-q', '-b', 'main', repo);
  gitIn(repo, 'add', '-A');
  gitIn(repo, 'commit', '-q', '-m', 'base');
  const worktree = path.join(root, 'wt');
  gitIn(repo, 'worktree', 'add', '-q', '-b', 'harness/task/t1', worktree);
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'top secret\n');
  const mock = await startMock();
  const spec = (over: Partial<SessionSpec> = {}): SessionSpec => {
    const configDir = path.join(root, 'cfg', randomUUID());
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    return {
      sessionId: randomUUID(), worktree, gitCommonDir: path.join(repo, '.git'), configDir, ports: null, env: {},
      auth: { mode: 'api-key', apiKey: DUMMY_KEY, baseUrl: mock.url }, instructions: 'HARNESS-INSTRUCTIONS', tools: [],
      ...over,
    };
  };
  return {
    root, repo, worktree, gitCommonDir: path.join(repo, '.git'), outside, mock, spec,
    cleanup: async () => { await mock.close(); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** Collects a session's observations in the background. */
export function collect(stream: AsyncIterable<Observation>) {
  const seen: (Observation & { t: number })[] = [];
  const done = (async () => { for await (const o of stream) seen.push({ ...o, t: Date.now() }); })();
  const until = async (pred: (o: Observation) => boolean, ms = 30_000): Promise<Observation> => {
    const end = Date.now() + ms;
    for (;;) {
      const hit = seen.find(pred);
      if (hit) return hit;
      if (Date.now() > end) throw new Error(`timed out; saw: ${seen.map((o) => o.kind).join(', ')}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  };
  /** Waits for the nth turn end (1-based). */
  const turns = (n: number, ms = 30_000) => until(() => seen.filter((o) => o.kind === 'turn.ended').length >= n, ms);
  return { seen, done, until, turns, of: <K extends Observation['kind']>(k: K) => seen.filter((o): o is Extract<Observation, { kind: K }> & { t: number } => o.kind === k) };
}

export const script = (...steps: string[]) => steps.map((s) => `#STEP ${s}`).join('\n');
export const echoTool = (calls: Record<string, unknown>[]): HarnessTool => ({
  name: 'echo', description: 'Echo the text back.', params: { text: { type: 'string', description: 'Text to echo', maxLength: 100 } },
  run: async (args) => { calls.push(args); return { text: `echo: ${String(args.text)}` }; },
});
