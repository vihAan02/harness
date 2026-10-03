// AgentAdapter and the per-vendor adapters (D-17; docs/agent-adapters.md). Vendor SDKs and
// vendor quirks live here and nowhere else (principle 10); test/structure.test.ts enforces it.
export type * from './adapter.ts';
export { AsyncQueue } from './queue.ts';
export { ClaudeAdapter, ClaudeSession, hardeningProblems } from './claude/adapter.ts';
export { compileClaudePermissions, GIT_DENY_WRITE, BASE_TOOLS, shimToolName } from './claude/policy.ts';
export { claudeHooks, editedPaths, relativize } from './claude/hooks.ts';
export { claudeCapabilities, PINNED } from './claude/version.ts';
