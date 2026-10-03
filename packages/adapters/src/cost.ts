// What a session's tokens cost (A/B metric M8; D-87). A vendor can only price the models it knows; for any
// other model (a third-party endpoint's), its figure is a guess (F-27). So when the local config gives
// prices for every model a session used, the cost is computed from those, and the basis says so.
import type { CostBasis, Prices } from './adapter.ts';

export type ModelTokens = {
  input: number; output: number; cacheRead: number; cacheCreation: number;
  vendorCostUsd: number; vendorBasis: 'list' | 'unknown';
};

/**
 * The session's cost and its basis. Each model is priced from the config where it has prices, otherwise
 * at the vendor's figure. The basis is `config` when every model had configured prices, `unknown` when
 * any figure is the vendor's guess for a model it can't price (F-27), and `list` otherwise.
 */
export function sessionCost(byModel: Record<string, ModelTokens>, prices: Record<string, Prices> = {}): { costUsd: number; costBasis: CostBasis } {
  let usd = 0;
  let allConfigured = true;
  let guessed = false;
  for (const [id, t] of Object.entries(byModel)) {
    const p = priceOf(prices, id);
    if (p) {
      usd += (t.input * p.input + t.output * p.output + t.cacheRead * (p.cacheRead ?? p.input) + t.cacheCreation * (p.cacheWrite ?? p.input)) / 1e6;
    } else {
      allConfigured = false;
      usd += t.vendorCostUsd;
      if (t.vendorBasis === 'unknown') guessed = true;
    }
  }
  const any = Object.keys(byModel).length > 0;
  return { costUsd: round(usd), costBasis: any && allConfigured ? 'config' : guessed ? 'unknown' : 'list' };
}

/** A model's prices; an id with a context suffix such as `[1m]` falls back to the bare id's prices. */
export function priceOf(prices: Record<string, Prices>, id: string): Prices | undefined {
  return prices[id] ?? prices[id.replace(/\[[^\]]*\]$/, '')];
}

const round = (usd: number) => Math.round(usd * 1e6) / 1e6;
