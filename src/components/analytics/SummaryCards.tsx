import { fmtCost, fmtTokens } from '../../lib/format';
import type { AnalyticsTotals } from '../../lib/analytics-api';
import { StatBox } from './shared';

export function SummaryCards({ totals }: { totals: AnalyticsTotals }) {
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
      <StatBox label="Total Sessions" value={totals.sessions} />
      <StatBox label="Total Cost" value={fmtCost(totals.cost)} />
      <StatBox label="Tokens In" value={fmtTokens(totals.tokensIn)} />
      <StatBox label="Tokens Out" value={fmtTokens(totals.tokensOut)} />
    </div>
  );
}
