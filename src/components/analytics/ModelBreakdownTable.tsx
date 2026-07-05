import {
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  LineChart,
  Line,
} from 'recharts';
import { fmtCost, fmtTokens } from '../../lib/format';
import type { ModelBreakdownResponse, ModelMixResponse } from '../../lib/analytics-api';
import { resolveModel } from '../../shared/agents/model-registry';
import { tooltipStyle, Empty } from './shared';

export function ModelBreakdownTable({ modelBreakdown }: { modelBreakdown: ModelBreakdownResponse }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-4 text-sm font-medium text-dim">Model Breakdown</h2>
      {modelBreakdown.models.length > 0 ? (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-dim">
              <th className="px-3 py-2 font-medium">Model</th>
              <th className="px-3 py-2 font-medium">Tier</th>
              <th className="px-3 py-2 font-medium">Tokens In</th>
              <th className="px-3 py-2 font-medium">Tokens Out</th>
              <th className="px-3 py-2 font-medium">
                {modelBreakdown.label === 'cost' ? 'Cost' : 'Equivalent $'}
              </th>
              <th className="px-3 py-2 font-medium">Share</th>
            </tr>
          </thead>
          <tbody>
            {modelBreakdown.models.map((m) => (
              <tr key={m.model} className={`border-b border-line last:border-0 ${m.unpriced ? 'opacity-70' : ''}`}>
                <td className="px-3 py-2 text-fg">
                  {m.model}
                  {m.unpriced && (
                    <span className="ml-2 rounded-sm bg-inset px-1.5 py-0.5 text-[10px] text-faint" data-testid="unpriced-badge">
                      unpriced
                    </span>
                  )}
                </td>
                <td className="px-3 py-2 text-dim">{m.tier}</td>
                <td className="px-3 py-2 mono-tabular text-fg">{fmtTokens(m.tokensIn)}</td>
                <td className="px-3 py-2 mono-tabular text-fg">{fmtTokens(m.tokensOut)}</td>
                <td className="px-3 py-2 mono-tabular text-fg">{m.unpriced ? '—' : fmtCost(m.equivalentUsd)}</td>
                <td className="px-3 py-2 mono-tabular text-dim">{Math.round(m.share * 100)}%</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <Empty text="No per-model usage yet" />
      )}
    </div>
  );
}

export function ModelMixCard({ modelMix }: { modelMix: ModelMixResponse }) {
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <div className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-medium text-dim">Model Mix</h2>
        <span className="text-xs text-dim">
          top-tier share (latest):{' '}
          <span className="mono-tabular text-fg">
            {modelMix.series.length > 0
              ? `${Math.round(modelMix.series[modelMix.series.length - 1].topTierShare * 100)}%`
              : '—'}
          </span>
        </span>
      </div>
      {modelMix.series.length > 0 ? (
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={modelMix.series.map((b) => ({ date: b.date, topTier: Math.round(b.topTierShare * 100) }))}>
            <XAxis dataKey="date" tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} />
            <YAxis tick={{ fill: 'var(--cd-faint)', fontSize: 10 }} tickFormatter={(v: number) => `${v}%`} />
            <Tooltip contentStyle={tooltipStyle} formatter={(v: number) => [`${v}%`, 'Top-tier share']} />
            <Line type="monotone" dataKey="topTier" stroke="var(--cd-accent)" strokeWidth={2} dot={false} />
          </LineChart>
        </ResponsiveContainer>
      ) : (
        <Empty text="No model mix data yet" />
      )}
    </div>
  );
}

export function ModelScorecard({ modelBreakdown }: { modelBreakdown: ModelBreakdownResponse }) {
  if (modelBreakdown.models.length === 0) return null;
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-1 text-sm font-medium text-dim">Model Scorecard</h2>
      <p className="mb-3 text-[10px] text-faint">
        Verification pass/fail lands with the Phase 5 verification gate; columns below are cost/speed/quota only.
      </p>
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-dim">
            <th className="px-3 py-2 font-medium">Model</th>
            <th className="px-3 py-2 font-medium">Tier</th>
            <th className="px-3 py-2 font-medium">Eff. $/MTok</th>
            <th className="px-3 py-2 font-medium">Quota Weight</th>
            <th className="px-3 py-2 font-medium">Verification</th>
          </tr>
        </thead>
        <tbody>
          {modelBreakdown.models.map((m) => {
            const entry = resolveModel(m.model);
            return (
              <tr key={m.model} className="border-b border-line last:border-0">
                <td className="px-3 py-2 text-fg">{m.model}</td>
                <td className="px-3 py-2 text-dim">{m.tier}</td>
                <td className="px-3 py-2 mono-tabular text-fg">{m.unpriced ? '—' : `$${m.effectiveRatePerMTok.toFixed(2)}`}</td>
                <td className="px-3 py-2 mono-tabular text-dim">{entry?.quotaWeight ?? '—'}</td>
                <td className="px-3 py-2 text-faint">—</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
