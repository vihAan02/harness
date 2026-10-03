// harness.yaml is committed, so teammates control it: it is untrusted input (D-52).
// - It can name a setup command, and a test command for the land step (0B, D-51), each of which runs
//   only after local approval, inside the sandbox.
// - It can ask for secrets by name; only names on the local allowlist get through.
// - It can lower numeric limits, never raise them.
// Unknown keys are ignored (services and contracts belong to later phases).
import fs from 'node:fs';
import path from 'node:path';
import { parse } from 'yaml';
import type { LocalConfig, ProjectConfig } from './config.ts';

export type RepoCommand = { command: string; manifests: string[] };
export type RepoConfig = {
  setup: RepoCommand | null;
  /** Run in the land step's integration worktree before the base moves (D-51). `timeoutSeconds` is capped locally. */
  test: (RepoCommand & { timeoutSeconds: number | null }) | null;
  envRefs: string[];
  portsPerAgent: number | null;
  maxConcurrentAgents: number | null;
};
export const NO_REPO_CONFIG: RepoConfig = { setup: null, test: null, envRefs: [], portsPerAgent: null, maxConcurrentAgents: null };

const MAX_BYTES = 64 * 1024;

/** A path inside the worktree that is a regular file (not a symlink), or null if absent. */
export function regularFileIn(worktree: string, rel: string): string | null {
  if (path.isAbsolute(rel) || rel.split(/[\\/]/).includes('..')) throw new Error(`${rel}: must be a relative path inside the repo`);
  const full = path.join(worktree, rel);
  let st: fs.Stats;
  try { st = fs.lstatSync(full); } catch { return null; }
  if (!st.isFile()) throw new Error(`${rel}: must be a regular file, not a symlink or directory`);
  return full;
}

export function readRepoConfig(worktree: string): RepoConfig {
  const file = regularFileIn(worktree, 'harness.yaml');
  if (!file) return NO_REPO_CONFIG;
  if (fs.statSync(file).size > MAX_BYTES) throw new Error('harness.yaml is larger than 64 KiB');
  let raw: unknown;
  try { raw = parse(fs.readFileSync(file, 'utf8'), { maxAliasCount: 50 }); } catch (e) { throw new Error(`harness.yaml: ${(e as Error).message}`); }
  if (raw === null || raw === undefined) return NO_REPO_CONFIG;
  const obj = (v: unknown, name: string): Record<string, unknown> => {
    if (v === undefined) return {};
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error(`harness.yaml: ${name} must be a mapping`);
    return v as Record<string, unknown>;
  };
  const top = obj(raw, 'the document');
  const setup = obj(top.setup, 'setup');
  const limit = (v: unknown, name: string) => {
    if (v === undefined) return null;
    if (!Number.isSafeInteger(v) || (v as number) < 1) throw new Error(`harness.yaml: ${name} must be a positive integer`);
    return v as number;
  };

  const command = (section: Record<string, unknown>, name: string): RepoCommand | null => {
    if (section.command === undefined) return null;
    if (typeof section.command !== 'string' || !section.command.trim() || section.command.length > 2000 || section.command.includes('\0')) {
      throw new Error(`harness.yaml: ${name}.command must be a non-empty string`);
    }
    const manifests = section.manifests ?? [];
    if (!Array.isArray(manifests) || manifests.length > 50 || !manifests.every((m) => typeof m === 'string' && m.length > 0)) {
      throw new Error(`harness.yaml: ${name}.manifests must be a list of paths`);
    }
    for (const m of manifests as string[]) regularFileIn(worktree, m); // reject traversal and symlinks up front
    return { command: section.command, manifests: manifests as string[] };
  };
  const setupCfg = command(setup, 'setup');
  const testSection = obj(top.test, 'test');
  const testCmd = command(testSection, 'test');
  const testCfg = testCmd ? { ...testCmd, timeoutSeconds: limit(testSection.timeout_seconds, 'test.timeout_seconds') } : null;

  const refs = obj(top.env, 'env').refs ?? [];
  if (!Array.isArray(refs) || !refs.every((r) => typeof r === 'string' && /^[A-Z_][A-Z0-9_]{0,63}$/.test(r))) {
    throw new Error('harness.yaml: env.refs must be a list of variable names');
  }
  return {
    setup: setupCfg,
    test: testCfg,
    envRefs: refs as string[],
    portsPerAgent: limit(obj(top.ports, 'ports').per_agent, 'ports.per_agent'),
    maxConcurrentAgents: limit(obj(top.limits, 'limits').max_concurrent_agents, 'limits.max_concurrent_agents'),
  };
}

/** What actually applies: the repo can narrow local policy, never widen it (D-52). */
export function effectivePolicy(local: LocalConfig, project: ProjectConfig, repo: RepoConfig) {
  return {
    portsPerAgent: Math.min(local.limits.portsPerAgent, repo.portsPerAgent ?? Infinity),
    maxConcurrentAgents: Math.min(local.limits.maxConcurrentAgents, repo.maxConcurrentAgents ?? Infinity),
    secretNames: repo.envRefs.filter((n) => project.secrets.includes(n)),
  };
}
