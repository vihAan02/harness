// Version pinning and capability flags (D-49). Capabilities are stated only for versions the 0A spike
// tested (docs/research/spike-0a.md); any other version is refused until it's re-verified.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Capabilities } from '../adapter.ts';

/** The Agent SDK and the Claude Code CLI it bundles, as tested in the spike (SP-01 to SP-15). */
export const PINNED = { sdk: '0.3.287', cli: '2.1.287' } as const;

/** The CLI's own skills at the pinned version, as its init reports them with settingSources: []. Anything else came from outside (D-45). */
export const BUILTIN_SKILLS = new Set([
  'deep-research', 'dataviz', 'update-config', 'verify', 'debug', 'code-review', 'simplify', 'batch', 'fewer-permission-prompts',
  'doctor', 'loop', 'claude-api', 'workflow-authoring', 'run', 'run-skill-generator', 'plugin-authoring',
]);

const VERIFIED: Record<string, Capabilities> = {
  [PINNED.cli]: {
    canCaptureReads: true, // PostToolUse on Read/Grep (F-07); used from 0B
    canDenyToolCalls: true,
    canInjectTurn: true, // streaming input (F-02, SP-02)
    canResume: true, // same CLAUDE_CONFIG_DIR and worktree (SP-07)
    supportsMCP: true, // in-process SDK MCP server (F-15)
    supportsHooks: true,
    readCaptureFidelity: 'tool-observed',
    canInjectBetweenTools: true,
    canSandboxReads: true, // flag-settings Read(//…) deny rules (SP-13, D-61)
    hooksFailClosed: { preToolUse: true, postToolUse: false, stop: false }, // PreToolUse on timeout only; a throw fails open (SP-10)
    authModes: ['api-key'], // Phase 0 uses API keys only (D-56)
  },
};

export function installedSdkVersion(): string {
  const entry = fileURLToPath(import.meta.resolve('@anthropic-ai/claude-agent-sdk'));
  const manifest = JSON.parse(fs.readFileSync(path.join(path.dirname(entry), 'package.json'), 'utf8')) as { version: string };
  return manifest.version;
}

/** Capabilities for a Claude Code CLI version. Throws for a version nobody has verified (D-49). */
export function claudeCapabilities(cliVersion: string): Capabilities {
  const caps = VERIFIED[cliVersion];
  if (!caps) throw new Error(`Claude Code ${cliVersion} hasn't been verified; the harness is pinned to ${PINNED.cli} (D-49)`);
  return caps;
}
