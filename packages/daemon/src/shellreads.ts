// Best-effort parsing of shell commands that read files (D-88, resolving Q-06; coordination.md §2). Only
// simple forms are recognized: cat, head, tail, less, more, `sed -n`, grep and rg with explicit file
// operands, and `< file` redirects. Anything with substitutions, variables, globs, `cd` or paths that
// leave the worktree is given up on, and counted, so coverage (H-03) shows what was missed. A reader
// is low confidence: the parser can't know what the command actually read.

export type ShellParse = {
  /** Files the command plainly reads, as written (relative to the worktree, or absolute). */
  reads: { path: string; range?: { start: number; lines: number } }[];
  /** Read-like commands the parser couldn't resolve to files (coverage, H-03). */
  unparsed: number;
};

const READERS = new Set(['cat', 'head', 'tail', 'less', 'more', 'sed', 'grep', 'rg', 'egrep', 'fgrep', 'wc', 'nl']);
/** Commands that likely read files but whose operands we don't interpret. */
const READ_LIKE = new Set(['awk', 'cut', 'sort', 'uniq', 'diff', 'jq', 'xxd', 'od', 'strings', 'python', 'python3', 'node', 'ruby', 'perl', 'find', 'xargs', 'bat', 'view', 'vim', 'tac']);
const GIVE_UP = /[`$*?[\]{}~]/; // substitutions, variables, globs, brace and tilde expansion

/** Splits a command line into simple commands at top-level `&&`, `||`, `;`, `|` and newlines, respecting quotes. */
export function splitCommands(line: string): string[][] | null {
  const out: string[][] = [];
  let words: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  const endWord = () => { if (has) words.push(cur); cur = ''; has = false; };
  const endCmd = () => { endWord(); if (words.length) out.push(words); words = []; };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; has = true; continue; }
    if (c === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (c === ' ' || c === '\t') { endWord(); continue; }
    if (c === '\n' || c === ';') { endCmd(); continue; }
    if (c === '&' && line[i + 1] === '&') { endCmd(); i++; continue; }
    if (c === '|') { endCmd(); if (line[i + 1] === '|') i++; continue; }
    if (c === '&') { endCmd(); continue; } // background
    if (c === '<' && line[i + 1] === '<') return null; // heredocs and here-strings: the body isn't commands; give up
    if (c === '<') { endWord(); words.push('<'); continue; }
    if (c === '>') { endWord(); words.push('>'); if (line[i + 1] === '>') i++; continue; }
    if (c === '(' || c === ')') return null; // subshells: give up
    cur += c;
    has = true;
  }
  if (quote) return null;
  endCmd();
  return out;
}

/** True for an operand we can safely treat as a file inside the worktree: no expansion, no escape. */
function plainPath(w: string): boolean {
  return !!w && !w.startsWith('-') && !GIVE_UP.test(w) && !w.split('/').includes('..');
}

/** Parses one simple command. Returns true if it changed directory, after which relative paths are ambiguous. */
function parseOne(words: string[], r: ShellParse, afterCd: boolean): boolean {
  // `< file` reads that file whatever the command is.
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i] === '<') { if (plainPath(words[i + 1]!) && !afterCd) r.reads.push({ path: words[i + 1]! }); else r.unparsed++; }
  }
  // Drop redirect targets, leading env assignments.
  const ws: string[] = [];
  for (let i = 0; i < words.length; i++) {
    if (words[i] === '<' || words[i] === '>') { i++; continue; }
    ws.push(words[i]!);
  }
  while (ws.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(ws[0]!)) ws.shift();
  const cmd = ws[0];
  if (!cmd) return false;
  const name = cmd.split('/').pop()!;
  if (name === 'cd' || name === 'pushd') return true; // later relative paths are ambiguous: counted, not guessed
  if (!READERS.has(name)) { if (READ_LIKE.has(name)) r.unparsed++; return false; }
  const args = ws.slice(1);
  if (afterCd || args.some((a) => GIVE_UP.test(a))) { r.unparsed++; return false; }
  const files: string[] = [];
  let range: { start: number; lines: number } | undefined;
  if (name === 'sed') {
    // Only `sed -n '<addr>p' files`: never -i, which edits.
    if (!args.includes('-n') || args.some((a) => a === '-i' || a.startsWith('-i') || a.startsWith('--in-place'))) { r.unparsed++; return false; }
    const rest = args.filter((a) => a !== '-n');
    const script = rest.shift();
    const m = script?.match(/^(\d+)(?:,(\d+))?p$/);
    if (m) range = { start: Number(m[1]), lines: m[2] ? Number(m[2]) - Number(m[1]) + 1 : 1 };
    if (!script || rest.some((a) => a.startsWith('-'))) { r.unparsed++; return false; }
    files.push(...rest);
  } else if (name === 'grep' || name === 'egrep' || name === 'fgrep' || name === 'rg') {
    // The first non-option operand is the pattern (unless -e/-f gave it); the rest are files. Recursive forms are counted, not parsed.
    if (args.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === '--recursive') && name !== 'rg') { r.unparsed++; return false; }
    const ops: string[] = [];
    let patternGiven = false;
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if (a === '-e' || a === '-f' || a === '--regexp' || a === '--file') { patternGiven = true; i++; continue; }
      if (/^-[A-Za-z]*[ABCm]$/.test(a) || ['--max-count', '-g', '--glob', '-t', '--type'].includes(a)) { i++; continue; } // options with a value
      if (a.startsWith('-')) continue;
      ops.push(a);
    }
    const operands = patternGiven ? ops : ops.slice(1);
    if (!operands.length) return false; // reads stdin
    if (name === 'rg' && operands.every((o) => !o.includes('.'))) { r.unparsed++; return false; } // rg dir: a search, not a file read
    files.push(...operands);
  } else {
    // cat, head, tail, less, more, wc, nl: options then files. head/tail -n N give a range for head.
    for (let i = 0; i < args.length; i++) {
      const a = args[i]!;
      if ((name === 'head' || name === 'tail') && (a === '-n' || a === '-c') && i + 1 < args.length) {
        if (name === 'head' && a === '-n' && /^\d+$/.test(args[i + 1]!)) range = { start: 1, lines: Number(args[i + 1]) };
        i++;
        continue;
      }
      const n = a.match(/^-(\d+)$/);
      if (n) { if (name === 'head') range = { start: 1, lines: Number(n[1]) }; continue; }
      if (a.startsWith('-')) continue;
      files.push(a);
    }
  }
  for (const f of files) {
    if (!plainPath(f)) { r.unparsed++; continue; }
    r.reads.push({ path: f, ...(range && files.length === 1 ? { range } : {}) });
  }
  return false;
}

export function parseShellReads(command: string): ShellParse {
  const r: ShellParse = { reads: [], unparsed: 0 };
  const cmds = splitCommands(command.slice(0, 10_000));
  if (!cmds) {
    if ([...READERS, ...READ_LIKE].some((w) => new RegExp(`(^|[\\s;|&(])${w}\\b`).test(command))) r.unparsed++;
    return r;
  }
  let afterCd = false;
  for (const words of cmds) afterCd = parseOne(words, r, afterCd) || afterCd;
  return r;
}
