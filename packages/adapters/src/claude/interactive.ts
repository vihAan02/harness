// The A/B baseline arm's Claude Code (validation.md §3, D-102): an interactive session in a terminal, given the
// policy an SDK session gets. The flags mirror what the pinned SDK passes the CLI for the same options:
// permission mode, tools, allow and deny lists, no setting sources, and the flag settings with the sandbox
// merged in. The SDK sends its system-prompt append over its control channel; here it's --append-system-prompt.
// No SDK callbacks run in an interactive session, so it has no hooks: the read confinement's call-time check
// and the dead-man (D-62, D-98) are the harness arm's only, while the deny rules and the sandbox are the same.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SessionSpec } from '../adapter.ts';
import type { ClaudePolicyBundle } from './policy.ts';

export type InteractiveLaunch = { command: string; args: string[]; env: Record<string, string>; cwd: string };

/** The pinned CLI binary the SDK runs (its platform package). */
export function claudeExecutable(): string {
  const manifest = fileURLToPath(import.meta.resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`));
  return path.join(path.dirname(manifest), 'claude');
}

/**
 * The CLI's own first-run state, so an interactive session starts working as an SDK one does: onboarding done,
 * the worktree trusted, and the API key approved. Without the approval the CLI asks whether to use the key,
 * defaults to no, and offers a subscription login instead (F-109), which the harness never uses (D-56). The
 * CLI keeps an approved key as its last 20 characters, in the agent's own config dir (D-65).
 */
export function seedInteractiveConfig(configDir: string, apiKey: string, worktree: string): void {
  const file = path.join(configDir, '.claude.json');
  let cfg: Record<string, any> = {};
  try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, any>; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const id = apiKey.trim().slice(-20);
  const seen = (cfg.customApiKeyResponses ?? {}) as { approved?: string[]; rejected?: string[] };
  cfg.customApiKeyResponses = { approved: [...new Set([...(seen.approved ?? []), id])], rejected: (seen.rejected ?? []).filter((x) => x !== id) };
  cfg.hasCompletedOnboarding = true;
  cfg.theme ??= 'dark';
  cfg.projects = { ...(cfg.projects ?? {}), [worktree]: { ...(cfg.projects?.[worktree] ?? {}), hasTrustDialogAccepted: true } };
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** A flag and its value, as the SDK writes them: `--name=value` when the value starts with a dash. */
function flag(args: string[], name: string, value: string): void {
  if (value.length > 1 && value.startsWith('-')) args.push(`--${name}=${value}`);
  else args.push(`--${name}`, value);
}

/** Pure: the command line for `spec` (real paths already) with its compiled policy and environment. */
export function interactiveLaunch(spec: SessionSpec, policy: ClaudePolicyBundle, env: Record<string, string>): InteractiveLaunch {
  const args: string[] = [];
  flag(args, 'allowedTools', (policy.allowedTools ?? []).join(','));
  flag(args, 'disallowedTools', (policy.disallowedTools ?? []).join(','));
  flag(args, 'tools', (policy.tools as string[]).join(','));
  args.push(`--setting-sources=${(policy.settingSources ?? []).join(',')}`);
  args.push('--strict-mcp-config'); // no MCP servers at all: the harness arm has only its own shim (D-45)
  flag(args, 'permission-mode', String(policy.permissionMode));
  args.push(`--session-id=${spec.sessionId}`); // its saved tool results land in the directory the read policy allows (F-101)
  if (spec.model) flag(args, 'model', spec.model.id);
  if (spec.instructions) flag(args, 'append-system-prompt', spec.instructions);
  flag(args, 'settings', JSON.stringify({ ...(policy.settings as object), sandbox: policy.sandbox }));
  return { command: claudeExecutable(), args, env, cwd: spec.worktree };
}
