import React, { useState } from 'react';
import { MemoryRouter, useSearchParams } from 'react-router';
import { BarChart3, Loader2 } from 'lucide-react';
import {
  useAnalyticsData, timeRangeToDays, timeRangeLabel,
} from '../hooks/useAnalyticsData';
import type { TabId, TimeRange } from '../hooks/useAnalyticsData';
import { TimeRangeSelector } from '../components/analytics/shared';
import { SummaryCards } from '../components/analytics/SummaryCards';
import { ActivityHeatmapCard } from '../components/analytics/ActivityHeatmapCard';
import {
  DailyCostCard, SessionsPerDayCard, SessionDurationCard, CostPerGoalCard, OutputTrendsCard,
} from '../components/analytics/CostCharts';
import { HeadroomPanel } from '../components/analytics/HeadroomPanel';
import { ToolUsagePanel } from '../components/analytics/ToolUsagePanel';
import { ModelBreakdownTable, ModelMixCard, ModelScorecard } from '../components/analytics/ModelBreakdownTable';
import { SubscriptionValuePanel, WindowUtilizationPanel, BudgetVsSpendPanel } from '../components/analytics/ValuePanels';
import { ContextManagementPanel } from '../components/analytics/ContextManagementPanel';
import type { ContextFilter } from '../components/analytics/ContextManagementPanel';

// The page is rendered inside the app router normally, but tests render it bare;
// fall back to a MemoryRouter when useSearchParams throws outside a router.
class RouterFallback extends React.Component<
  { children: React.ReactNode },
  { needsRouter: boolean }
> {
  state = { needsRouter: false };
  static getDerivedStateFromError() {
    return { needsRouter: true };
  }
  render() {
    if (this.state.needsRouter) {
      return <MemoryRouter>{this.props.children}</MemoryRouter>;
    }
    return this.props.children;
  }
}

export default function AnalyticsPage() {
  return (
    <RouterFallback>
      <AnalyticsPageContent />
    </RouterFallback>
  );
}

function AnalyticsPageContent() {
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab: TabId = searchParams.get('tab') === 'context' ? 'context' : 'analytics';
  const setActiveTab = (tab: TabId) => setSearchParams({ tab }, { replace: true });
  const [timeRange, setTimeRange] = useState<TimeRange>('30d');
  const [contextFilter, setContextFilter] = useState<ContextFilter>('all');

  const {
    loading, errors, totals, toolUsage, dailyCosts, heatmap, sessionsPerDay,
    durations, jiraStories, prsMerged, contextItems,
    modelBreakdown, modelMix, providerValue, windowUtil, costPerGoal, headroomStats,
  } = useAnalyticsData(timeRange, activeTab);

  const rangeLabel = timeRangeLabel(timeRange);
  const heatmapDayCount = timeRangeToDays(timeRange) || 90;

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-dim" />
      </div>
    );
  }

  const tabs: { id: TabId; label: string }[] = [
    { id: 'analytics', label: 'Analytics' },
    { id: 'context', label: 'Context Management' },
  ];

  return (
    <div className="flex flex-col h-full">
      <div className="flex-shrink-0 flex items-center justify-between pb-4">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-6 w-6 text-accent" />
          <div className="flex gap-1">
            {tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'border-accent text-accent'
                    : 'border-transparent text-dim hover:text-fg'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        </div>
        <TimeRangeSelector value={timeRange} onChange={setTimeRange} />
      </div>

      <div className="flex-1 overflow-y-auto">
      {activeTab === 'analytics' && (
        <div className="space-y-6">
          {/* Summary cards */}
          <SummaryCards totals={totals} />

          {/* Activity Heatmap */}
          <ActivityHeatmapCard data={heatmap} dayCount={heatmapDayCount} rangeLabel={rangeLabel} />

          <div className="grid gap-6 lg:grid-cols-2">
            {/* Daily cost chart */}
            <DailyCostCard data={dailyCosts} error={!!errors['daily-costs']} />

            {/* Sessions per day trend */}
            <SessionsPerDayCard data={sessionsPerDay} error={!!errors['sessions-per-day']} />

            {/* Headroom compression savings */}
            <HeadroomPanel stats={headroomStats} />

            {/* Tool usage by category */}
            <ToolUsagePanel toolUsage={toolUsage} error={!!errors['tool-usage']} />

            {/* Session duration distribution */}
            <SessionDurationCard data={durations} error={!!errors['session-durations']} />
          </div>

          {/* Model Breakdown */}
          <ModelBreakdownTable modelBreakdown={modelBreakdown} />

          {/* Model Mix + top-tier-share */}
          <ModelMixCard modelMix={modelMix} />

          {/* Subscription Value (seat providers) */}
          <SubscriptionValuePanel providerValue={providerValue} />

          {/* Window Utilization (seat only, estimate) */}
          <WindowUtilizationPanel windowUtil={windowUtil} />

          {/* Budget vs Spend (metered providers — work profile) */}
          <BudgetVsSpendPanel providerValue={providerValue} />

          {/* Model Scorecard */}
          <ModelScorecard modelBreakdown={modelBreakdown} />

          {/* Cost per Completed Goal */}
          <CostPerGoalCard costPerGoal={costPerGoal} />

          {/* Output Trends */}
          <OutputTrendsCard jiraStories={jiraStories} prsMerged={prsMerged} />
        </div>
      )}

      {activeTab === 'context' && (
        <div className="space-y-6">
          <ContextManagementPanel items={contextItems} filter={contextFilter} onFilterChange={setContextFilter} />
        </div>
      )}
      </div>
    </div>
  );
}
