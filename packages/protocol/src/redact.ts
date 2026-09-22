/** Credential patterns stripped from anything an agent shares with the room (streams, summaries). */
const SECRET_PATTERNS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, // OpenAI/Stripe/Anthropic-style keys
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, // JWTs
  /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/g,
  // KEY=value and "key": "value" where the key names a credential (DB_PASSWORD, api_key, clientSecret, …).
  /\b([A-Za-z0-9_]*?(?:api[_-]?key|secret|token|passw(?:or)?d|pwd|authorization|credential|private[_-]?key)[A-Za-z0-9_]*)["']?\s*[:=]\s*["']?(?!Bearer\b|\[redacted\])[^\s"']{6,}/gi,
];

/** Best-effort removal of obvious credentials before anything leaves the machine. */
export function redact(text: string): string {
  let out = text;
  for (const re of SECRET_PATTERNS) {
    out = out.replace(re, (m: string, key?: unknown) => {
      if (typeof key === "string" && m.startsWith(key)) return `${key}=[redacted]`;
      return m.startsWith("Bearer") ? "Bearer [redacted]" : "[redacted]";
    });
  }
  return out;
}
