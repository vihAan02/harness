// The LLM judge for M2 and M6 (A9; validation.md §9 "Rubric"): one run's record in, its judge.json out. It
// builds two prompts from the fixed rubric in scripts/ab/rubric/ and the run's diffs, card titles and edit
// history, asks the judge model through OpenRouter's Anthropic-compatible endpoint (temperature 0, Anthropic
// as the only provider, no fallback), and checks each answer against JudgeResult (scripts/ab/summary.ts).
// Everything from the record goes into the prompts as delimited untrusted data. The judge never sees the
// hidden checks, the arm or the run id (B11). M6 reads the agents' edits from their transcripts, which §9
// notes can reveal the arm; only the edit calls are taken from them.
//
//   node scripts/ab/judge.ts --record runs/record/<run-id>      needs OPENROUTER_API_KEY
//   node scripts/ab/judge.ts --record <dir> --dry               a deterministic stub, no network: checks the pipeline
//
//   --cards <dir>   the scenario cards (default scripts/ab/scenarios)
//   --model <id>    the judge (default anthropic/claude-sonnet-5.5, validation.md §9)
//   --force         replace an existing judge.json
//
// The key is never printed: error bodies from the provider are redacted before they're shown.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { checkJudgeParts, checkSummary, type JudgeResult, type RunSummary } from './summary.ts';

export const ENDPOINT = 'https://openrouter.ai/api/v1/messages';
export const DEFAULT_MODEL = 'anthropic/claude-sonnet-5.5';
/** What a --dry judge.json names as its judge; the scorer marks the evaluation incomplete when it sees one. */
export const DRY_MODEL = 'dry';
const RUBRIC_DIR = path.join(import.meta.dirname, 'rubric');
const EDIT_TOOLS = ['Edit', 'Write', 'MultiEdit', 'NotebookEdit'];

/** How much of the record goes into a prompt: per patch, for the whole edit history, per edit. What's cut is marked and listed. */
export const LIMITS = { patch: 40_000, edits: 40_000, snippet: 600 };
export type Limits = typeof LIMITS;

export type Card = { scenario: string; name: string; tasks: { key: string; agent: string; title: string }[] };
export type Edit = { agent: string; at: string | null; tool: string; file: string; snippet: string };
export type RecordInput = {
  summary: RunSummary; card: Card; patches: { name: string; text: string }[]; main: string | null; transcripts: { agent: string; text: string }[];
};
export type Prompt = { kind: 'm2' | 'm6'; system: string; user: string; cut: string[] };

/** Never show the key, or the tail some providers echo back in a 401 (F-72). */
export function redactor(key: string): (s: string) => string {
  if (!key) return (s) => s;
  return (s) => s.split(key).join('[key]').split(key.slice(-8)).join('[key]').replace(/\bsk-[A-Za-z0-9_-]{6,}/g, 'sk-[redacted]');
}

/** Keeps the head and the tail of `text` within about `max` characters, at line breaks, marking the cut. */
export function clip(text: string, max: number): { text: string; cut: number } {
  if (text.length <= max) return { text, cut: 0 };
  const head = text.lastIndexOf('\n', Math.floor(max * 0.6)) + 1 || Math.floor(max * 0.6);
  const tail = text.indexOf('\n', text.length - Math.floor(max * 0.4)) + 1 || text.length - Math.floor(max * 0.4);
  return { text: `${text.slice(0, head)}[… ${tail - head} characters cut here …]\n${text.slice(tail)}`, cut: tail - head };
}

/** Record content as untrusted data, between markers it can't forge: they carry a hash of it. */
export function untrusted(name: string, content: string): string {
  const id = createHash('sha256').update(name).update('\0').update(content).digest('hex').slice(0, 16);
  const body = !content || content.endsWith('\n') ? content : `${content}\n`;
  return `<<<UNTRUSTED DATA ${id}: ${name.replace(/[^\w./ -]/g, '_')}>>>\n${body}<<<END UNTRUSTED DATA ${id}>>>`;
}

const lines = (prefix: string, s: unknown) => String(s ?? '').split('\n').map((l) => `${prefix}${l}`).join('\n');
const short = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}… [${s.length - max} more characters]`);

/** What one edit call replaced (-) and wrote (+). */
function describe(tool: string, input: Record<string, any>): string {
  if (tool === 'Edit') return `${lines('- ', input.old_string)}\n${lines('+ ', input.new_string)}`;
  if (tool === 'MultiEdit') return (Array.isArray(input.edits) ? input.edits : []).map((e: Record<string, any>) => `${lines('- ', e.old_string)}\n${lines('+ ', e.new_string)}`).join('\n');
  if (tool === 'Write') return `(the whole file, ${String(input.content ?? '').split('\n').length} lines)\n${lines('+ ', input.content)}`;
  return lines('+ ', input.new_source);
}

/**
 * An agent's file edits from its Claude Code transcript (JSONL): every Edit, Write, MultiEdit and NotebookEdit
 * call, with its time, its file (relative to the session's directory) and a bounded snippet. Calls whose result
 * was an error (denied, or nothing matched) changed nothing and are left out, counted.
 */
export function extractEdits(agent: string, jsonl: string, snippet = LIMITS.snippet): { edits: Edit[]; failed: number; unreadable: number } {
  const calls: (Edit & { id: string })[] = [];
  const errored = new Set<string>();
  let unreadable = 0;
  for (const line of jsonl.split('\n')) {
    if (!line.trim()) continue;
    let o: Record<string, any>;
    try {
      o = JSON.parse(line) as Record<string, any>;
    } catch (e) {
      if (!(e instanceof SyntaxError)) throw e;
      unreadable++;
      continue;
    }
    const content = o?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content as Record<string, any>[]) {
      if (o.type === 'assistant' && b?.type === 'tool_use' && EDIT_TOOLS.includes(b.name)) {
        const input = (b.input ?? {}) as Record<string, any>;
        let file = String(input.file_path ?? input.notebook_path ?? '?');
        if (typeof o.cwd === 'string' && file.startsWith(`${o.cwd}/`)) file = file.slice(o.cwd.length + 1);
        calls.push({ id: String(b.id ?? ''), agent, at: typeof o.timestamp === 'string' ? o.timestamp : null, tool: b.name, file, snippet: short(describe(b.name, input), snippet) });
      }
      if (o.type === 'user' && b?.type === 'tool_result' && b.is_error === true) errored.add(String(b.tool_use_id));
    }
  }
  const edits = calls.filter((c) => !errored.has(c.id)).map(({ id: _id, ...e }) => e);
  return { edits, failed: calls.length - edits.length, unreadable };
}

/** The rubric for one judgement: the file, and for M6 only the scenario's own planted coupling. */
export function rubric(kind: 'm2' | 'm6', scenario: string, dir = RUBRIC_DIR): string {
  const text = fs.readFileSync(path.join(dir, `${kind}.md`), 'utf8');
  const at = text.indexOf('\n### SC-');
  if (at < 0) return text;
  const own = text.slice(at + 1).split(/\n(?=### SC-)/).find((s) => s.startsWith(`### ${scenario}\n`));
  if (!own) throw new Error(`${kind}.md has no section for ${scenario}`);
  return `${text.slice(0, at)}\n${own.trimEnd()}\n`;
}

/** One run's record as the judge reads it: summary, card, diffs, transcripts. */
export function loadRecord(dir: string, cardsDir: string): RecordInput {
  const summary = checkSummary(JSON.parse(fs.readFileSync(path.join(dir, 'summary.json'), 'utf8')), path.join(dir, 'summary.json'));
  const card = JSON.parse(fs.readFileSync(path.join(cardsDir, `${summary.scenario}.json`), 'utf8')) as Card;
  const read = (sub: string, ext: string) => {
    const d = path.join(dir, sub);
    return !fs.existsSync(d) ? [] : fs.readdirSync(d).sort().filter((f) => f.endsWith(ext)).map((f) => ({ name: f.slice(0, -ext.length), text: fs.readFileSync(path.join(d, f), 'utf8') }));
  };
  const diffs = read('diffs', '.patch');
  return {
    summary, card, patches: diffs.filter((p) => p.name !== 'main'), main: diffs.find((p) => p.name === 'main')?.text ?? null,
    transcripts: read('transcripts', '.jsonl').map((t) => ({ agent: t.name, text: t.text })),
  };
}

/** The M2 and M6 prompts for one run. Neither names the arm, the run id or the agents' model. */
export function buildPrompts(input: RecordInput, limits: Limits = LIMITS, rubricDir = RUBRIC_DIR): Prompt[] {
  const { summary: s, card } = input;
  const header = [
    `Scenario ${s.scenario} ("${card.name}"), from base commit ${s.base_sha}.`,
    'The two tasks, from their cards:',
    ...card.tasks.map((t) => `- ${t.key}, agent "${t.agent}": "${t.title}"`),
  ];
  const block = (cut: string[], name: string, text: string, max: number) => {
    const c = clip(text, max);
    if (c.cut) cut.push(`${name}: ${c.cut.toLocaleString('en-US')} of ${text.length.toLocaleString('en-US')} characters cut from the middle`);
    return untrusted(name, c.text);
  };
  const patches = (cut: string[]) => {
    if (!input.patches.length) cut.push('no task diffs were recorded');
    return input.patches.map((p) => `${p.name}'s final diff from the base:\n${block(cut, `diffs/${p.name}.patch`, p.text, limits.patch)}`);
  };
  const finish = (kind: Prompt['kind'], cut: string[], parts: string[]): Prompt => ({
    kind, cut, system: rubric(kind, s.scenario, rubricDir),
    user: [...parts, ...(cut.length ? [`Some data is missing or was shortened to fit: ${cut.join('; ')}.`] : []), 'Answer with the JSON object only, as the rubric specifies.'].join('\n\n'),
  });

  const c2: string[] = [];
  if (input.main === null) c2.push("main's final diff wasn't recorded");
  const m2 = finish('m2', c2, [header.join('\n'), ...patches(c2), ...(input.main === null ? [] : [`Main's final diff from the base:\n${block(c2, 'diffs/main.patch', input.main, limits.patch)}`])]);

  const c6: string[] = [];
  const timeline = [
    `The run started at ${s.started_at} and ended at ${s.ended_at}.`,
    ...s.tasks.map((t) => `- ${t.key} (agent "${t.agent}") was ${t.integrated_at ? `integrated at ${t.integrated_at}` : 'never integrated'}.`),
  ];
  const all: Edit[] = [];
  for (const t of input.transcripts) {
    const x = extractEdits(t.agent, t.text, limits.snippet);
    all.push(...x.edits);
    if (x.failed) c6.push(`${x.failed} of ${t.agent}'s edit calls failed (denied, or nothing matched) and are left out`);
    if (x.unreadable) c6.push(`${t.agent}'s transcript has ${x.unreadable} line(s) that aren't JSON`);
  }
  if (!input.transcripts.length) c6.push('no transcripts were recorded');
  const order = (e: Edit) => (e.at === null ? Infinity : Date.parse(e.at));
  const history = all.map((e, i) => ({ e, i })).sort((a, b) => order(a.e) - order(b.e) || a.i - b.i)
    .map(({ e }) => `[${e.at ?? 'time unknown'}] ${e.agent} ${e.tool} ${e.file}\n${e.snippet}`).join('\n\n');
  const m6 = finish('m6', c6, [
    header.join('\n'), timeline.join('\n'), ...patches(c6),
    `Both agents' file edits, in time order (${all.length}):\n${block(c6, 'edit history', history || '(no edits)', limits.edits)}`,
  ]);
  return [m2, m6];
}

/** The JSON object in a reply: the whole reply, or its outermost {...} (a model may add a fence or a sentence). */
export function parseAnswer(text: string): unknown {
  const t = text.trim();
  try {
    return JSON.parse(t);
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  const [a, b] = [t.indexOf('{'), t.lastIndexOf('}')];
  if (a < 0 || b <= a) throw new Error('no JSON object in the reply');
  return JSON.parse(t.slice(a, b + 1));
}

type Message = { role: 'user' | 'assistant'; content: string };
export type Asker = { model: string; key: string; fetch: typeof fetch };

/** One request to the judge. Throws on an error status, with the key redacted from whatever the provider sent back. */
export async function ask(system: string, messages: Message[], o: Asker): Promise<{ text: string; cost: number | null; served: string | null; stop: string | null }> {
  const redact = redactor(o.key);
  let res: Response;
  try {
    res = await o.fetch(ENDPOINT, {
      method: 'POST', signal: AbortSignal.timeout(300_000),
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', authorization: `Bearer ${o.key}` },
      body: JSON.stringify({ model: o.model, max_tokens: 8192, temperature: 0, provider: { only: ['anthropic'], allow_fallbacks: false }, system, messages }),
    });
  } catch (e) {
    throw new Error(`no answer from ${ENDPOINT}: ${redact((e as Error).message)}`);
  }
  const raw = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status} from the judge: ${redact(raw).slice(0, 600)}`);
  let body: Record<string, any>;
  try {
    body = JSON.parse(raw) as Record<string, any>;
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
    throw new Error(`the judge's response isn't JSON: ${redact(raw).slice(0, 300)}`);
  }
  const text = (Array.isArray(body.content) ? body.content : []).filter((b: any) => b?.type === 'text').map((b: any) => String(b.text)).join('');
  return { text, cost: typeof body.usage?.cost === 'number' ? body.usage.cost : null, served: typeof body.model === 'string' ? body.model : null, stop: typeof body.stop_reason === 'string' ? body.stop_reason : null };
}

/** One judgement: ask, check the answer against the schema, and ask once more if it isn't valid. */
async function judgeOne(p: Prompt, o: Asker): Promise<{ answer: Pick<JudgeResult, 'm2' | 'm6'>; costs: (number | null)[]; served: (string | null)[] }> {
  const messages: Message[] = [{ role: 'user', content: p.user }];
  const costs: (number | null)[] = [];
  const served: (string | null)[] = [];
  for (let attempt = 0; ; attempt++) {
    const r = await ask(p.system, messages, o);
    costs.push(r.cost);
    served.push(r.served);
    try {
      if (r.stop === 'max_tokens') throw new Error('the reply was cut off at max_tokens');
      return { answer: checkJudgeParts(parseAnswer(r.text), `the ${p.kind.toUpperCase()} answer`, [p.kind]), costs, served };
    } catch (e) {
      if (attempt >= 1) throw new Error(`${(e as Error).message}, after one retry`);
      messages.push({ role: 'assistant', content: r.text || '(empty)' }, { role: 'user', content: `That answer isn't valid: ${(e as Error).message}. Reply with only the JSON object the rubric specifies, nothing else.` });
    }
  }
}

/** Judges one run: both prompts, both answers checked. `notes` says what the operator should know (cuts, cost, the model that answered). */
export async function judgeRun(input: RecordInput, o: Asker, limits: Limits = LIMITS, rubricDir = RUBRIC_DIR): Promise<{ result: JudgeResult; notes: string[] }> {
  const prompts = buildPrompts(input, limits, rubricDir);
  const notes = prompts.flatMap((p) => p.cut.map((c) => `${p.kind.toUpperCase()} prompt: ${c}`));
  let m2: JudgeResult['m2'] | undefined;
  let m6: JudgeResult['m6'] | undefined;
  const costs: (number | null)[] = [];
  const served = new Set<string>();
  for (const p of prompts) {
    const r = await judgeOne(p, o);
    costs.push(...r.costs);
    for (const m of r.served) if (m) served.add(m);
    if (p.kind === 'm2') m2 = r.answer.m2;
    else m6 = r.answer.m6;
  }
  const unpriced = costs.filter((c) => c === null).length;
  if (unpriced) notes.push(`the provider reported no cost for ${unpriced} of ${costs.length} calls; those count as $0`);
  const asked = o.model.replace(/^[^/]+\//, '');
  const other = [...served].filter((m) => m !== o.model && m.replace(/^[^/]+\//, '') !== asked);
  if (other.length) notes.push(`asked for ${o.model}, but the response names ${other.join(', ')}`);
  return { result: { v: 1, run_id: input.summary.run_id, judge_model: o.model, m2: m2!, m6: m6!, cost_usd: costs.reduce<number>((a, c) => a + (c ?? 0), 0) }, notes };
}

/** The --dry stub: a fixed, valid, empty answer to each prompt, with no network. */
export const dryFetch: typeof fetch = async (_url, init) => {
  const body = JSON.parse(String(init?.body)) as { system: string; model: string };
  const text = body.system.startsWith('# M6') ? '{"m6": {"incidents": []}}' : '{"m2": {"units": [], "lines_removed_in_integration": 0}}';
  return new Response(JSON.stringify({ model: body.model, content: [{ type: 'text', text }], stop_reason: 'end_turn', usage: { input_tokens: 0, output_tokens: 0, cost: 0 } }));
};

async function main(): Promise<void> {
  const USAGE = 'usage: node scripts/ab/judge.ts --record <runs/record/run-id> [--cards <dir>] [--model <id>] [--dry] [--force]';
  let values: Record<string, string | boolean | undefined>;
  try {
    ({ values } = parseArgs({
      strict: true, allowPositionals: false,
      options: { record: { type: 'string' }, cards: { type: 'string' }, model: { type: 'string' }, dry: { type: 'boolean' }, force: { type: 'boolean' }, help: { type: 'boolean', short: 'h' } },
    }));
  } catch (e) {
    console.error(`${(e as Error).message}\n${USAGE}`);
    process.exit(2);
  }
  if (values.help) { console.log(USAGE); process.exit(0); }
  if (typeof values.record !== 'string') { console.error(USAGE); process.exit(2); }
  const dir = values.record;
  const out = path.join(dir, 'judge.json');
  if (fs.existsSync(out) && !values.force) { console.error(`judge: ${out} exists; --force replaces it`); process.exit(2); }
  const dry = values.dry === true;
  const key = dry ? '' : (process.env.OPENROUTER_API_KEY ?? '');
  if (!dry && !key) { console.error('judge: set OPENROUTER_API_KEY (or use --dry)'); process.exit(2); }
  const redact = redactor(key);
  try {
    const input = loadRecord(dir, typeof values.cards === 'string' ? values.cards : path.join(import.meta.dirname, 'scenarios'));
    if (input.summary.void !== null) { console.log(`judge: run ${input.summary.run_id} is void (${input.summary.void}); void runs aren't scored`); return; }
    const { result, notes } = await judgeRun(input, { model: dry ? DRY_MODEL : typeof values.model === 'string' ? values.model : DEFAULT_MODEL, key, fetch: dry ? dryFetch : fetch });
    fs.writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
    for (const n of notes) console.log(`  note: ${n}`);
    const copies = result.m2.units.reduce((n, u) => n + u.extra_copies, 0);
    console.log(`${result.run_id} (${input.summary.scenario}): M2 ${result.m2.units.length} unit(s), ${copies} extra cop${copies === 1 ? 'y' : 'ies'}; `
      + `M6 ${result.m6.incidents.length} incident(s), ${result.m6.incidents.filter((x) => x.caught).length} caught; $${result.cost_usd.toFixed(4)} (${result.judge_model}). Wrote ${out}`);
  } catch (e) {
    console.error(`judge: ${redact((e as Error).message)}`);
    process.exit(1);
  }
}

if (import.meta.main) await main();
