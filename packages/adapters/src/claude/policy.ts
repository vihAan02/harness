// compilePermissions for Claude Code (agent-adapters.md §5; D-45, D-46, D-60, D-64, D-66, D-68).
// Every rule here was tested against the pinned version in the 0A spike (SP-05, SP-08, SP-13).
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import type { SessionSpec } from '../adapter.ts';

/** The explicit base tool set (D-66): no self-scheduling, worktree, network or subagent tools. */
export const BASE_TOOLS = ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'] as const;
/** The vendor's own peer channel stays off; peer traffic flows only through the harness (D-46, F-17). */
export const PEER_TOOLS = ['SendMessage', 'ListAgents'] as const;
/** Shared-.git entries the sandbox write-denies, so agents can't touch refs, objects or hooks while `git status` works (D-60, SP-05). */
export const GIT_DENY_WRITE = ['config', 'hooks', 'refs', 'objects', 'packed-refs', 'info', 'worktrees', 'HEAD', 'index', 'logs'] as const;
/** Every auth variable the CLI reads reaches the CLI but never the agent's shell, whichever one a session uses (D-64, D-87). */
export const AUTH_ENV_VARS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN'] as const;
export const SHIM_SERVER = 'harness';

export const shimToolName = (name: string) => `mcp__${SHIM_SERVER}__${name}`;
/** Claude Code permission rules write an absolute path as `//abs/path`. */
const abs = (p: string) => `/${p.replace(/\/+$/, '')}`;
/** A path a permission rule can name literally: no glob or rule syntax in it. Others are left to the read check and the sandbox. */
const RULE_SAFE = /^[^()[\]{}*?\\\u0000-\u001f\u007f]+$/;

export type ClaudePolicyBundle = Pick<Options, 'permissionMode' | 'tools' | 'allowedTools' | 'disallowedTools' | 'settingSources' | 'sandbox' | 'settings'>;

/**
 * Pure: the session's permission, sandbox and settings options. Paths must already be real paths
 * (no symlinks), because the sandbox matches resolved paths. `denied` is the read policy's static deny
 * list (`deniedEntries`), computed by the caller from the filesystem.
 */
export function compileClaudePermissions(spec: Pick<SessionSpec, 'worktree' | 'gitCommonDir' | 'ports' | 'tools' | 'readPolicy'>, denied: string[] = []): ClaudePolicyBundle {
  const rp = spec.readPolicy;
  for (const p of [spec.worktree, spec.gitCommonDir, ...(rp ? [...rp.denyRoots, ...rp.allowRoots] : []), ...denied]) {
    if (!p.startsWith('/') || p.includes('/../') || p.endsWith('/..')) throw new Error(`policy paths must be absolute and normalized: ${p}`);
  }
  const editRule = `Edit(${abs(spec.worktree)}/**)`;
  const writeRule = `Write(${abs(spec.worktree)}/**)`;
  // Read confinement (D-61, D-98): Read deny rules for the file tools, one per denied entry, since a deny
  // rule beats any allow and can't carve the worktree out of a denied root (F-98). They also reach the
  // sandbox; the sandbox's own denyRead/allowRead confine shell reads, including entries created later (F-99).
  const readDeny = denied.filter((p) => RULE_SAFE.test(p)).flatMap((p) => [`Read(${abs(p)})`, `Read(${abs(p)}/**)`]);
  return {
    permissionMode: 'dontAsk', // explicit; never auto (F-11). Nothing prompts; anything off the list is denied
    tools: [...BASE_TOOLS],
    // D-60: path-scoped Edit/Write, never bare. Reads are allowed, then confined by the deny rules below,
    // the sandbox and the PreToolUse read check (D-98).
    allowedTools: ['Read', 'Grep', 'Glob', 'Bash', editRule, writeRule, ...spec.tools.map((t) => shimToolName(t.name))],
    disallowedTools: [...PEER_TOOLS],
    settingSources: [], // D-45: no repo or user settings, hooks, MCP servers or plugins
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false, // load-bearing: with true, dangerouslyDisableSandbox escaped (SP-05)
      autoAllowBashIfSandboxed: true,
      filesystem: {
        denyWrite: GIT_DENY_WRITE.map((x) => `${spec.gitCommonDir}/${x}`),
        ...(rp ? { denyRead: rp.denyRoots, allowRead: [...rp.allowRoots, ...(rp.allowLinks ?? [])] } : {}),
      },
      credentials: { envVars: AUTH_ENV_VARS.map((name) => ({ name, mode: 'deny' as const })) },
      ...(spec.ports ? { network: { allowLocalBinding: true } } : {}), // D-68
    } as Options['sandbox'],
    // The flag-settings layer reaches the sandbox even with settingSources: [] (SP-13).
    settings: {
      permissions: { allow: [editRule], ...(readDeny.length ? { deny: readDeny } : {}) },
      bashEditDiffEnabled: true, // Bash edits show up in PostToolUse (F-07)
      crossSessionInbound: 'refuse', // D-46
    } as Options['settings'],
  };
}
