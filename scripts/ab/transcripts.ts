// What a Claude Code transcript says about a baseline session (validation.md §4, §9; B9b): the tokens each
// model used (M8, priced like the harness arm's), the human's messages after the card (M5, M7), interrupts,
// and tool calls the allow list denied (M5b). The baseline has no event log, so its transcripts are the
// record; the harness arm's are saved too, for the judge (M6).
import fs from 'node:fs';
import path from 'node:path';
import { sessionCost, type ModelTokens } from '../../packages/adapters/src/cost.ts';
import type { Prices } from '../../packages/adapters/src/adapter.ts';

type Entry = {
  type?: string; isMeta?: boolean; timestamp?: string; isSidechain?: boolean;
  /** The CLI's own entries: a compaction's summary of the conversation so far, and other text shown only in the transcript. */
  isCompactSummary?: boolean; isVisibleInTranscriptOnly?: boolean;
  message?: { id?: string; role?: string; model?: string; content?: unknown; usage?: Record<string, number> };
};
type Block = { type?: string; text?: string; content?: unknown; is_error?: boolean };

export type TranscriptFacts = {
  /** Prompts the human sent, the card included, with their times. */
  prompts: { at: string | null; chars: number }[];
  interrupts: number;
  denied: number;
  byModel: Record<string, ModelTokens>;
};

/** Every transcript file under a Claude Code config dir (`projects/<cwd>/<session>.jsonl`), oldest first. */
export function transcriptFiles(configDir: string): string[] {
  const root = path.join(configDir, 'projects');
  if (!fs.existsSync(root)) return [];
  const files = (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => f.endsWith('.jsonl')).map((f) => path.join(root, f));
  return files.sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
}

const blocks = (content: unknown): Block[] => (Array.isArray(content) ? content as Block[] : typeof content === 'string' ? [{ type: 'text', text: content }] : []);
const textOf = (bs: Block[]) => bs.filter((b) => b.type === 'text').map((b) => b.text ?? '').join('\n');
const INTERRUPT = /^\[Request interrupted by user/;
/** The CLI's own wrappers around slash commands and their output: not a message to the agent. */
const WRAPPER = /^<(command-name|command-message|command-args|local-command-stdout|local-command-caveat)>/;
/** How the CLI words a tool call its permission rules refused (dontAsk mode never asks; F-11). */
const DENIED = /Permission to use .* (?:has been|was) denied|permission (?:rule|settings) .*denied/i;

/** Pure: the facts in one session's transcript lines. Streamed assistant messages repeat; the last copy of each counts. */
export function readTranscript(lines: string[]): TranscriptFacts {
  const out: TranscriptFacts = { prompts: [], interrupts: 0, denied: 0, byModel: {} };
  const usage = new Map<string, { model: string; u: Record<string, number> }>();
  for (const line of lines) {
    let e: Entry;
    try { e = JSON.parse(line) as Entry; } catch { continue; }
    if (e.isSidechain) continue; // a subagent's own conversation: its usage is in its parent's tool result too
    if (e.type === 'assistant' && e.message?.usage && e.message.model) {
      usage.set(e.message.id ?? `${usage.size}`, { model: e.message.model, u: e.message.usage });
    } else if (e.type === 'user' && !e.isMeta && !e.isCompactSummary && !e.isVisibleInTranscriptOnly && e.message) {
      // A compaction's summary is a user entry with no isMeta (the pinned CLI): the CLI wrote it, not the human (M5).
      const bs = blocks(e.message.content);
      for (const b of bs) {
        if (b.type === 'tool_result' && b.is_error && DENIED.test(typeof b.content === 'string' ? b.content : textOf(blocks(b.content)))) out.denied++;
      }
      if (bs.some((b) => b.type === 'tool_result')) continue;
      const text = textOf(bs).trim();
      if (!text || WRAPPER.test(text)) continue;
      if (INTERRUPT.test(text)) { out.interrupts++; continue; }
      out.prompts.push({ at: e.timestamp ?? null, chars: text.length });
    }
  }
  for (const { model, u } of usage.values()) {
    const t = (out.byModel[model] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, vendorCostUsd: 0, vendorBasis: 'unknown' });
    t.input += u.input_tokens ?? 0;
    t.output += u.output_tokens ?? 0;
    t.cacheRead += u.cache_read_input_tokens ?? 0;
    t.cacheCreation += u.cache_creation_input_tokens ?? 0;
  }
  return out;
}

/** M8 from transcripts: tokens summed over sessions, priced from the provider table as the harness arm's are. */
export function transcriptUsage(facts: TranscriptFacts[], prices: Record<string, Prices>) {
  const byModel: Record<string, ModelTokens> = {};
  for (const f of facts) {
    for (const [m, t] of Object.entries(f.byModel)) {
      const s = (byModel[m] ??= { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, vendorCostUsd: 0, vendorBasis: 'unknown' });
      s.input += t.input; s.output += t.output; s.cacheRead += t.cacheRead; s.cacheCreation += t.cacheCreation;
    }
  }
  const sum = (k: keyof Omit<ModelTokens, 'vendorBasis'>) => Object.values(byModel).reduce((n, t) => n + t[k], 0);
  const { costUsd, costBasis } = sessionCost(byModel, prices);
  return {
    input: sum('input'), output: sum('output'), cache_read: sum('cacheRead'), cache_creation: sum('cacheCreation'),
    cost_usd: costUsd, cost_basis: costBasis, models: Object.keys(byModel).sort(),
  };
}
