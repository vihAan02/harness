// The harness tool shim as an in-process SDK MCP server (protocol.md §6; F-15). alwaysLoad keeps
// tool search from deferring it. The tools' behaviour is harnessd's; this only adapts the shape.
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import type { HarnessTool, ToolParam } from '../adapter.ts';
import { SHIM_SERVER } from './policy.ts';

/** The tool-input schema for one parameter. Numbers are whole numbers (seconds, counts), within `min`/`max` if given. */
export function paramSchema(p: ToolParam) {
  const s = p.type === 'string' ? (p.maxLength ? z.string().max(p.maxLength) : z.string())
    : p.type === 'number' ? z.number().int().min(p.min ?? Number.MIN_SAFE_INTEGER).max(p.max ?? Number.MAX_SAFE_INTEGER)
      : z.array(z.string()).max(100);
  const described = s.describe(p.description);
  return p.optional ? described.optional() : described;
}

export function shimServer(tools: HarnessTool[]): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: SHIM_SERVER,
    version: '0.0.0',
    alwaysLoad: true,
    tools: tools.map((t) => tool(t.name, t.description, Object.fromEntries(Object.entries(t.params).map(([k, p]) => [k, paramSchema(p)])),
      async (args) => {
        try {
          const r = await t.run(args as Record<string, unknown>);
          return { content: [{ type: 'text' as const, text: r.text }], ...(r.isError ? { isError: true } : {}) };
        } catch (e) {
          return { content: [{ type: 'text' as const, text: `harness error: ${(e as Error).message}` }], isError: true };
        }
      })),
  });
}
