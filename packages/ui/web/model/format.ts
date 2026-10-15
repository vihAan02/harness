// The UI's display formatters: one place for a cost and a commit id, so every view shows them the same way.

export function formatUsd(usd: number, digits = 3): string {
  return `$${usd.toFixed(digits)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
