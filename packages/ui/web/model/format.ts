export function formatCost(usd: number): string {
  return `$${usd.toFixed(3)}`;
}

export function shortSha(sha: string): string {
  return sha.slice(0, 12);
}
