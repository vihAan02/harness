// Test support: a scripted stand-in for the Anthropic Messages API, adapted from the 0A spike's
// lib/mock-api.ts (copied, never imported: D-44).
//
// Claude Code does permissions, hooks, sandboxing and message queueing on the
// client. The model only chooses tool calls. So for those mechanics we point a
// real Claude Code binary at this mock (ANTHROPIC_BASE_URL) and script the
// "model" exactly, including tool calls a well-behaved model would refuse.
//
// Scripting: any user text block may contain lines of the form
//   #STEP <ToolName> <json-input>      one tool call (several #STEP lines with the
//   #STEP+ <ToolName> <json-input>     same step use #STEP+ to add parallel calls)
//   #STEP TEXT <text>                  a final text answer (ends the turn)
//   #SLOW <ms>                         delay every response in this script
// A tool input may contain {{find:<regex>}}: replaced by the regex's first group, matched against the
// conversation's user content, latest first (e.g. the ID of a message the harness delivered).
// The mock finds the LAST user text block that contains #STEP lines, counts the
// assistant messages after it, and plays that step. When steps run out it ends
// the turn with "done".
//
// Never logs credential values: only whether x-api-key matched the dummy and
// whether any Authorization header was present.
import http from 'node:http';
import fs from 'node:fs';

export const DUMMY_KEY = 'sk-ant-spike-dummy-not-a-real-key';

type Block = any;
type Msg = { role: 'user' | 'assistant'; content: string | Block[] };
export type Step = { tools?: { name: string; input: any }[]; text?: string };

export type MockLogEntry = {
  i: number; t: number; path: string; kind: 'main' | 'side' | 'other';
  authOk: boolean; bearerPresent: boolean; model?: string;
  summary?: any; stepIndex?: number; emitted?: any;
};

function textBlocks(m: Msg): string[] {
  if (typeof m.content === 'string') return [m.content];
  return m.content.filter((b) => b.type === 'text').map((b) => b.text as string);
}

function parseScript(text: string) {
  const steps: Step[] = [];
  let slow = 0;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const slowM = line.match(/^#SLOW (\d+)/);
    if (slowM) slow = Number(slowM[1]);
    const m = line.match(/^#STEP(\+?) (\S+)\s*(.*)$/);
    if (!m) continue;
    const [, plus, name, rest] = m;
    if (name === 'TEXT') { steps.push({ text: rest }); continue; }
    const call = { name: name!, input: rest ? JSON.parse(rest) : {} };
    if (plus && steps.length && steps[steps.length - 1]!.tools) steps[steps.length - 1]!.tools!.push(call);
    else steps.push({ tools: [call] });
  }
  return { steps, slow };
}

export function summarize(messages: Msg[]) {
  return messages.map((m) => {
    if (typeof m.content === 'string') return { role: m.role, blocks: [{ type: 'text', text: m.content.slice(0, 4000) }] };
    return {
      role: m.role,
      blocks: m.content.map((b: Block) => {
        if (b.type === 'text') return { type: 'text', text: String(b.text).slice(0, 4000) };
        if (b.type === 'tool_use') return { type: 'tool_use', name: b.name, id: b.id };
        if (b.type === 'tool_result') {
          const c = typeof b.content === 'string' ? b.content : (b.content || []).map((x: any) => x.text ?? `[${x.type}]`).join(' ');
          return { type: 'tool_result', id: b.tool_use_id, is_error: !!b.is_error, text: String(c).slice(0, 4000) };
        }
        return { type: b.type };
      }),
    };
  });
}

function allUserText(messages: Msg[]): string[] {
  return messages.filter((m) => m.role === 'user').map((m) => typeof m.content === 'string' ? m.content
    : m.content.map((b: Block) => b.type === 'text' ? b.text : b.type === 'tool_result'
      ? (typeof b.content === 'string' ? b.content : (b.content || []).map((x: Block) => x.text ?? '').join('\n')) : '').join('\n'));
}

/** Resolves {{find:<regex>}} placeholders in a scripted tool input against the conversation. */
function fillFinds(input: unknown, messages: Msg[]): unknown {
  const texts = allUserText(messages).reverse();
  const fill = (v: unknown): unknown => {
    if (typeof v === 'string') return v.replace(/\{\{find:(.+?)\}\}/g, (_, re: string) => {
      for (const t of texts) { const m = t.match(new RegExp(re)); if (m) return m[1] ?? m[0]; }
      return '(not found)';
    });
    if (Array.isArray(v)) return v.map(fill);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fill(x)]));
    return v;
  };
  return fill(input);
}

export type Mock = {
  url: string; port: number; log: MockLogEntry[];
  rawDir?: string; close: () => Promise<void>;
  onMain?: (body: any, entry: MockLogEntry) => void;
  /** Main-loop requests answered with these errors first, in order. */
  failPlan?: { status: number; body: any; headers?: Record<string, string> }[];
};

export async function startMock(opts: { rawDir?: string; name?: string } = {}): Promise<Mock> {
  const log: MockLogEntry[] = [];
  let counter = 0;
  let toolCounter = 0;
  const mock: Mock = { url: '', port: 0, log, rawDir: opts.rawDir, close: async () => {} };
  if (opts.rawDir) fs.mkdirSync(opts.rawDir, { recursive: true });

  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', async () => {
      const i = counter++;
      const authOk = req.headers['x-api-key'] === DUMMY_KEY;
      const bearerPresent = !!req.headers['authorization'];
      const path = req.url || '';
      let body: any = {};
      try { body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}; } catch { body = {}; }
      const entry: MockLogEntry = { i, t: Date.now(), path, kind: 'other', authOk, bearerPresent, model: body.model };
      log.push(entry);

      if (path.startsWith('/v1/messages/count_tokens')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: 1000 }));
        return;
      }
      if (!path.startsWith('/v1/messages')) {
        // Unknown endpoint: record it, answer with an empty success.
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(path.startsWith('/v1/models') ? JSON.stringify({ data: [], has_more: false }) : '{}');
        return;
      }
      const tools: any[] = body.tools || [];
      const isMain = tools.some((t) => ['Bash', 'Read', 'Edit', 'Write'].includes(t.name));
      entry.kind = isMain ? 'main' : 'side';
      const messages: Msg[] = body.messages || [];
      if (opts.rawDir) fs.writeFileSync(`${opts.rawDir}/${String(i).padStart(4, '0')}-${entry.kind}.json`, JSON.stringify(body, null, 1));

      let step: Step = { text: 'ok' };
      let slow = 0;
      if (isMain && mock.failPlan?.length) {
        const fail = mock.failPlan.shift()!;
        entry.emitted = { error: fail.status };
        res.writeHead(fail.status, { 'content-type': 'application/json', ...(fail.headers ?? {}) });
        res.end(JSON.stringify(fail.body));
        return;
      }
      if (isMain) {
        entry.summary = summarize(messages);
        // Find the last user message whose text carries a script.
        let scriptIdx = -1; let script = { steps: [] as Step[], slow: 0 };
        for (let k = messages.length - 1; k >= 0; k--) {
          if (messages[k]!.role !== 'user') continue;
          const txt = textBlocks(messages[k]!).join('\n');
          if (txt.includes('#STEP')) { scriptIdx = k; script = parseScript(txt); break; }
        }
        const assistantsAfter = messages.slice(scriptIdx + 1).filter((m) => m.role === 'assistant').length;
        entry.stepIndex = assistantsAfter;
        step = script.steps[assistantsAfter] ?? { text: 'done' };
        if (step.tools) step = { tools: step.tools.map((t) => ({ name: t.name, input: fillFinds(t.input, messages) })) };
        slow = script.slow;
        mock.onMain?.(body, entry);
      }
      if (slow) await new Promise((r) => setTimeout(r, slow));

      const content: any[] = [];
      if (step.text !== undefined) content.push({ type: 'text', text: step.text });
      for (const call of step.tools || []) content.push({ type: 'tool_use', id: `toolu_spike_${toolCounter++}`, name: call.name, input: call.input });
      const stopReason = step.tools?.length ? 'tool_use' : 'end_turn';
      entry.emitted = content.map((c) => (c.type === 'text' ? { text: c.text } : { tool: c.name, input: c.input }));
      const usage = { input_tokens: 100 + i, output_tokens: 10, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      const msgId = `msg_spike_${i}`;

      if (!body.stream) {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_spike_${i}` });
        res.end(JSON.stringify({ id: msgId, type: 'message', role: 'assistant', model: body.model, content, stop_reason: stopReason, stop_sequence: null, usage }));
        return;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_spike_${i}` });
      const send = (event: string, data: any) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      send('message_start', { type: 'message_start', message: { id: msgId, type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });
      content.forEach((c, idx) => {
        if (c.type === 'text') {
          send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'text', text: '' } });
          send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'text_delta', text: c.text } });
        } else {
          send('content_block_start', { type: 'content_block_start', index: idx, content_block: { type: 'tool_use', id: c.id, name: c.name, input: {} } });
          send('content_block_delta', { type: 'content_block_delta', index: idx, delta: { type: 'input_json_delta', partial_json: JSON.stringify(c.input) } });
        }
        send('content_block_stop', { type: 'content_block_stop', index: idx });
      });
      send('message_delta', { type: 'message_delta', delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
      send('message_stop', { type: 'message_stop' });
      res.end();
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const port = (server.address() as any).port;
  mock.port = port; mock.url = `http://127.0.0.1:${port}`;
  mock.close = () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); });
  return mock;
}
