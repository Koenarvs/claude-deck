import { fmtCost } from '../../lib/format';
import type { ProviderValueResponse, WindowUtilizationResponse } from '../../lib/analytics-api';

export function SubscriptionValuePanel({ providerValue }: { providerValue: ProviderValueResponse }) {
  if (!providerValue.providers.some((p) => p.label === 'equivalent_value')) return null;
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-4 text-sm font-medium text-dim">Subscription Value</h2>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {providerValue.providers.filter((p) => p.label === 'equivalent_value').map((p) => (
          <div key={p.provider} className="rounded-md border border-line bg-inset p-4">
            <p className="text-xs text-dim capitalize">{p.provider}</p>
            <p className="mt-1 mono-tabular text-2xl font-bold text-fg">
              {p.valueMultiplier ? `${p.valueMultiplier}x` : '—'}
            </p>
            <p className="mt-1 text-xs text-dim">
              {fmtCost(p.equivalentUsd)} value{p.seatPriceUsdMonthly ? ` / ${fmtCost(p.seatPriceUsdMonthly)}/mo` : ''}
            </p>
            <p className="mt-2 text-[10px] text-faint" title="Replacement value: what the same tokens would cost at metered API rates. Overstates somewhat at zero marginal cost.">
              replacement value — overstates at zero marginal cost
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

export function WindowUtilizationPanel({ windowUtil }: { windowUtil: WindowUtilizationResponse }) {
  if (windowUtil.rows.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-medium text-dim">Window Utilization</h2>
        <span className="rounded-sm bg-inset px-1.5 py-0.5 text-[10px] text-faint">estimate</span>
      </div>
      <div className="space-y-3">
        {windowUtil.rows.map((r) => (
          <div key={r.provider} className="flex items-center gap-3">
            <span className="w-24 text-xs text-dim capitalize">{r.provider}</span>
            <div className="flex-1 h-4 bg-inset rounded overflow-hidden">
              <div className="h-full rounded bg-accent transition-all" style={{ width: `${Math.min(100, r.utilizationPct)}%` }} />
            </div>
            <span className="w-12 text-right mono-tabular text-xs text-fg">{r.utilizationPct}%</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function BudgetVsSpendPanel({ providerValue }: { providerValue: ProviderValueResponse }) {
  if (!providerValue.providers.some((p) => p.label === 'cost')) return null;
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-4 text-sm font-medium text-dim">Budget vs Spend</h2>
      <div className="space-y-3">
        {providerValue.providers.filter((p) => p.label === 'cost').map((p) => {
          const pct = p.budgetUsd && p.budgetUsd > 0 ? Math.min(100, (p.equivalentUsd / p.budgetUsd) * 100) : 0;
          const over = p.budgetUsd !== undefined && p.equivalentUsd > p.budgetUsd;
          return (
            <div key={p.provider} className="flex items-center gap-3">
              <span className="w-24 text-xs text-dim capitalize">{p.provider}</span>
              <div className="flex-1 h-4 bg-inset rounded overflow-hidden">
                <div className="h-full rounded transition-all" style={{ width: `${pct}%`, backgroundColor: over ? 'var(--cd-warn)' : 'var(--cd-ok)' }} />
              </div>
              <span className="w-28 text-right mono-tabular text-xs text-fg">
                {fmtCost(p.equivalentUsd)}{p.budgetUsd !== undefined ? ` / ${fmtCost(p.budgetUsd)}` : ''}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
