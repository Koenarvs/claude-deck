import { fmtCost, fmtTokens } from '../../lib/format';
import type { HeadroomStatsResponse } from '../../lib/analytics-api';
import { Empty } from './shared';

export function HeadroomPanel({ stats }: { stats: HeadroomStatsResponse }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-4 text-sm font-medium text-dim">Headroom Compression</h2>
      {stats.enabled && stats.requests > 0 ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <div className="rounded-md border border-line p-3">
            <div className="text-xs text-dim">Token Savings</div>
            <div className="mt-1 text-lg font-semibold text-fg">
              {stats.savingsPercent.toFixed(1)}%
            </div>
            <div className="text-xs text-faint">avg {stats.avgCompressionPct.toFixed(1)}% / best {stats.bestCompressionPct.toFixed(1)}%</div>
          </div>
          <div className="rounded-md border border-line p-3">
            <div className="text-xs text-dim">Tokens Saved</div>
            <div className="mt-1 text-lg font-semibold text-fg">{fmtTokens(stats.tokensSaved)}</div>
            <div className="text-xs text-faint">lifetime {fmtTokens(stats.lifetimeTokensSaved)}</div>
          </div>
          <div className="rounded-md border border-line p-3">
            <div className="text-xs text-dim">Cache Hit Rate</div>
            <div className="mt-1 text-lg font-semibold text-fg">{stats.cacheHitRate.toFixed(1)}%</div>
            <div className="text-xs text-faint">net {fmtTokens(stats.netTokens)} tok</div>
          </div>
          <div className="rounded-md border border-line p-3">
            <div className="text-xs text-dim">$ Saved</div>
            <div className="mt-1 text-lg font-semibold text-fg">{fmtCost(stats.compressionSavingsUsd)}</div>
            <div className="text-xs text-faint">{stats.requests} requests</div>
          </div>
        </div>
      ) : (
        <Empty text="No headroom data — proxy disabled or unreachable" />
      )}
    </div>
  );
}
