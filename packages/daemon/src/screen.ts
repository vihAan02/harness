// The T-5 message screen (D-118, TH-4): text from a peer agent or another human, or a task another human wrote, that
// asks the agent to read outside its scope, send file contents or credentials, widen its scope or approvals, or
// disable or skip tests, checks, hooks or the sandbox, is held for the local human's `security_review` before the
// agent sees it. Released text is delivered verbatim (D-63).
// The screen is a tripwire, not the boundary: the sandbox and the read rules hold whatever an agent is talked into
// (D-47). So it's tuned to catch the asks, and to let ordinary coordination through: a benign question or notice
// is never held (T-5's negative control).

export type ScreenHit = { rule: string; excerpt: string };

const RULES: [string, RegExp][] = [
  // Disabling or skipping the checks that would catch a bad change.
  ['disable_checks', /\b(skip|skipping|disable|disabling|bypass|bypassing|turn off|comment out|silence)\b[^.\n]{0,40}\b(tests?|checks?|ci|hooks?|pre-commit|lint(?:er|ing)?|sandbox|guardrails?|type ?check(?:s|ing)?|required checks?)\b/i],
  ['disable_checks', /\b(remove|delete|drop)\b[^.\n]{0,40}\b(tests?|test files?|test suites?|ci|hooks?|sandbox|workflows?)\b/i],
  ['disable_checks', /--no-verify|--no-tests|\bSKIP_TESTS\b|\b(?:it|test|describe)\.skip\(|dangerously-?skip-?permissions|bypassPermissions/i],
  // Reading outside the task: the home directory, credentials, harness state, another checkout.
  ['read_outside_scope', /(?:~\/|\$HOME\b|\/Users\/[^/\s]+\/|\/etc\/(?:passwd|shadow|hosts)|\.ssh\b|\.aws\b|\.gnupg\b|\.harness\b|\.config\/gh\b|\bkeychains?\b|\bid_(?:rsa|ed25519|ecdsa)\b|\.netrc\b|\.npmrc\b|(?:^|[\s'"`/])\.env(?:\.[\w-]+)?\b)/i],
  ['read_outside_scope', /\b(read|open|cat|print|show|list|grep)\b[^.\n]{0,40}\b(outside|other|another|parent)\b[^.\n]{0,20}\b(worktrees?|repos?|repositor(?:y|ies)|director(?:y|ies)|folders?|scope|checkouts?)\b/i],
  // Sending contents or credentials somewhere.
  ['send_contents', /\b(send|paste|upload|share|forward|exfiltrate|email|leak)\b[^.\n]{0,60}\b(contents?|secrets?|api[- ]?keys?|private keys?|ssh keys?|tokens?|credentials?|passwords?|env(?:ironment)? (?:vars?|variables?)|\.env)\b/i],
  ['send_contents', /\bcurl\b[^\n]{0,120}(?:\s-d\b|\s--data\b|\s-F\b|\s-T\b|--upload-file|\|\s*(?:sh|bash)\b)|\b(?:nc|netcat|ncat)\s+-?\w*\s*\d{1,3}\.\d|\bbase64\b[^.\n]{0,40}\b(?:keys?|tokens?|secrets?|\.env)\b/i],
  // Widening the task's scope, its permissions or the harness's own configuration.
  ['widen_scope', /\b(widen|expand|extend|increase|raise|lift|loosen)\b[^.\n]{0,30}\b(scope|permissions?|allow ?lists?|approvals?|limits?|budgets?|sandbox)\b/i],
  ['widen_scope', /\b(approve|grant|allow)\b[^.\n]{0,30}\b(yourself|itself|automatically|everything|all (?:commands|tools|paths))\b/i],
  ['widen_scope', /\b(edit|modify|change|write to|overwrite|touch|update)\b[^.\n]{0,40}(?:\.github\/|harness\.yaml|AGENTS\.md|CLAUDE\.md|\.claude\/|settings(?:\.local)?\.json|CODEOWNERS|config\.toml)/i],
  // Overriding the agent's instructions.
  ['instruction_override', /\bignore\b[^.\n]{0,20}\b(previous|prior|above|earlier|your|all)\b[^.\n]{0,20}\b(instructions|rules|guidelines|prompts?)\b|\byou are now\b|\b(?:new|updated) system prompt\b/i],
];

/** What in `text` a human must review before an agent sees it; empty when nothing matches. */
export function screenText(text: string): ScreenHit[] {
  const hits: ScreenHit[] = [];
  for (const [rule, re] of RULES) {
    const m = re.exec(text);
    if (!m || hits.some((h) => h.rule === rule)) continue;
    const at = Math.max(0, m.index - 20);
    hits.push({ rule, excerpt: text.slice(at, m.index + m[0].length + 20).replace(/\s+/g, ' ').trim().slice(0, 160) });
  }
  return hits;
}
