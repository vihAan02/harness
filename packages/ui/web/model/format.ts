// The UI's display formatters: one place for a cost and a commit id, so every view shows them the same way.

export function formatCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
