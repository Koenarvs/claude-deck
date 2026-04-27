/** Shared formatting utilities for tokens, cost, and numeric display. */

/** Format USD cost: $0.00, $1.23, etc. */
export function fmtCost(usd: number): string {
  if (usd === 0) return '$0.00';
  return `$${usd.toFixed(2)}`;
}

/** Format token counts: 0, 1.2K, 3.4M, etc. */
export function fmtTokens(n: number): string {
  if (n === 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}
