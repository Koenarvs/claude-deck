import { useState, useEffect, useCallback } from 'react';
import { BarChart3, Star, Zap, Clock, DollarSign, TrendingUp, Check, X, RefreshCw, History, Lightbulb } from 'lucide-react';

// ── Types ───────────────────────────────────────────────────────────────────

interface SkillMetrics {
  execution_count: number;
  success_rate: number;
  avg_duration_s: number;
  avg_cost_usd: number;
  total_cost_usd: number;
  last_execution: SkillExecution | null;
}

interface SkillExecution {
  id: string;
  session_id: string | null;
  skill_name: string;
  started_at: number;
  ended_at: number | null;
  duration_s: number | null;
  estimated_cost_usd: number | null;
  tool_call_count: number;
  tool_error_count: number;
  outcome: string;
  user_rating: number | null;
  user_notes: string | null;
}

interface SkillSuggestion {
  id: string;
  skill_name: string;
  suggestion_type: string;
  title: string;
  description: string | null;
  diff_content: string;
  status: string;
  created_at: number;
}

interface SkillVersion {
  id: string;
  skill_name: string;
  version_number: number;
  content_snapshot: string;
  change_reason: string | null;
  created_at: number;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatDate(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function outcomeColor(outcome: string): string {
  switch (outcome) {
    case 'success': return 'text-deck-success';
    case 'failure': return 'text-deck-danger';
    case 'partial': return 'text-yellow-400';
    default: return 'text-deck-muted';
  }
}

// ── Main Component ──────────────────────────────────────────────────────────

export default function SkillDetailPanel({ skillName }: { skillName: string }) {
  const [activeSection, setActiveSection] = useState<'metrics' | 'suggestions' | 'history' | 'versions'>('metrics');
  const [metrics, setMetrics] = useState<SkillMetrics | null>(null);
  const [suggestions, setSuggestions] = useState<SkillSuggestion[]>([]);
  const [executions, setExecutions] = useState<SkillExecution[]>([]);
  const [versions, setVersions] = useState<SkillVersion[]>([]);
  const [analyzing, setAnalyzing] = useState(false);
  const [ratingExecId, setRatingExecId] = useState<string | null>(null);
  const [ratingValue, setRatingValue] = useState(0);
  const [ratingNotes, setRatingNotes] = useState('');

  const fetchMetrics = useCallback(async () => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/metrics`);
      if (res.ok) setMetrics(await res.json());
    } catch { /* non-fatal */ }
  }, [skillName]);

  const fetchSuggestions = useCallback(async () => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/suggestions`);
      if (res.ok) setSuggestions(await res.json());
    } catch { /* non-fatal */ }
  }, [skillName]);

  const fetchExecutions = useCallback(async () => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/executions?limit=20`);
      if (res.ok) setExecutions(await res.json());
    } catch { /* non-fatal */ }
  }, [skillName]);

  const fetchVersions = useCallback(async () => {
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/versions`);
      if (res.ok) setVersions(await res.json());
    } catch { /* non-fatal */ }
  }, [skillName]);

  useEffect(() => {
    void fetchMetrics();
    void fetchSuggestions();
    void fetchExecutions();
    void fetchVersions();
  }, [fetchMetrics, fetchSuggestions, fetchExecutions, fetchVersions]);

  const handleAnalyze = useCallback(async () => {
    setAnalyzing(true);
    try {
      const res = await fetch(`/api/skills/${encodeURIComponent(skillName)}/analyze`, { method: 'POST' });
      if (res.ok) {
        await fetchSuggestions();
        setActiveSection('suggestions');
      }
    } catch { /* non-fatal */ }
    finally { setAnalyzing(false); }
  }, [skillName, fetchSuggestions]);

  const handleApply = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/skills/suggestions/${id}/apply`, { method: 'POST' });
      if (res.ok) {
        await Promise.all([fetchSuggestions(), fetchVersions()]);
      }
    } catch { /* non-fatal */ }
  }, [fetchSuggestions, fetchVersions]);

  const handleDismiss = useCallback(async (id: string) => {
    try {
      const res = await fetch(`/api/skills/suggestions/${id}/dismiss`, { method: 'POST' });
      if (res.ok) await fetchSuggestions();
    } catch { /* non-fatal */ }
  }, [fetchSuggestions]);

  const handleRate = useCallback(async () => {
    if (!ratingExecId || ratingValue < 1) return;
    try {
      await fetch(`/api/skills/executions/${ratingExecId}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating: ratingValue, notes: ratingNotes || undefined }),
      });
      setRatingExecId(null);
      setRatingValue(0);
      setRatingNotes('');
      await fetchExecutions();
    } catch { /* non-fatal */ }
  }, [ratingExecId, ratingValue, ratingNotes, fetchExecutions]);

  const handleRevert = useCallback(async (versionId: string) => {
    try {
      const res = await fetch(`/api/skills/versions/${versionId}/revert`, { method: 'POST' });
      if (res.ok) await fetchVersions();
    } catch { /* non-fatal */ }
  }, [fetchVersions]);

  const sections = [
    { id: 'metrics' as const, label: 'Metrics', icon: BarChart3 },
    { id: 'suggestions' as const, label: `Suggestions${suggestions.length > 0 ? ` (${suggestions.length})` : ''}`, icon: Lightbulb },
    { id: 'history' as const, label: 'History', icon: History },
    { id: 'versions' as const, label: 'Versions', icon: Clock },
  ];

  return (
    <div className="mt-4 space-y-4">
      {/* Section tabs */}
      <div className="flex gap-1 border-b border-deck-border">
        {sections.map((s) => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              type="button"
              onClick={() => setActiveSection(s.id)}
              className={`flex items-center gap-1.5 border-b-2 px-3 py-1.5 text-xs font-medium transition-colors ${
                activeSection === s.id
                  ? 'border-deck-accent text-deck-accent'
                  : 'border-transparent text-deck-muted hover:text-deck-text'
              }`}
            >
              <Icon size={13} />
              {s.label}
            </button>
          );
        })}
      </div>

      {activeSection === 'metrics' && (
        <MetricsPanel metrics={metrics} onAnalyze={handleAnalyze} analyzing={analyzing} hasExecutions={executions.length > 0} />
      )}

      {activeSection === 'suggestions' && (
        <SuggestionsPanel suggestions={suggestions} onApply={handleApply} onDismiss={handleDismiss} />
      )}

      {activeSection === 'history' && (
        <ExecutionHistory
          executions={executions}
          ratingExecId={ratingExecId}
          ratingValue={ratingValue}
          ratingNotes={ratingNotes}
          onStartRate={(id) => { setRatingExecId(id); setRatingValue(0); setRatingNotes(''); }}
          onSetRating={setRatingValue}
          onSetNotes={setRatingNotes}
          onSubmitRate={handleRate}
          onCancelRate={() => setRatingExecId(null)}
        />
      )}

      {activeSection === 'versions' && (
        <VersionHistory versions={versions} onRevert={handleRevert} />
      )}
    </div>
  );
}

// ── Metrics Panel ───────────────────────────────────────────────────────────

function MetricsPanel({ metrics, onAnalyze, analyzing, hasExecutions }: {
  metrics: SkillMetrics | null;
  onAnalyze: () => void;
  analyzing: boolean;
  hasExecutions: boolean;
}) {
  if (!metrics) {
    return <div className="text-sm text-deck-muted">Loading metrics...</div>;
  }

  const cards = [
    { label: 'Executions', value: metrics.execution_count.toString(), icon: Zap },
    { label: 'Success Rate', value: `${Math.round(metrics.success_rate * 100)}%`, icon: TrendingUp },
    { label: 'Avg Duration', value: metrics.avg_duration_s > 0 ? formatDuration(metrics.avg_duration_s) : '--', icon: Clock },
    { label: 'Avg Cost', value: metrics.avg_cost_usd > 0 ? formatCost(metrics.avg_cost_usd) : '--', icon: DollarSign },
  ];

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <div key={card.label} className="rounded-lg border border-deck-border bg-deck-bg p-3">
              <div className="flex items-center gap-1.5 text-xs text-deck-muted">
                <Icon size={12} />
                {card.label}
              </div>
              <div className="mt-1 text-lg font-semibold text-deck-text">{card.value}</div>
            </div>
          );
        })}
      </div>

      {metrics.total_cost_usd > 0 && (
        <div className="text-xs text-deck-muted">
          Total cost: {formatCost(metrics.total_cost_usd)}
        </div>
      )}

      <button
        type="button"
        onClick={onAnalyze}
        disabled={analyzing || !hasExecutions}
        className="flex items-center gap-2 rounded bg-deck-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-deck-accent-hover disabled:opacity-50"
      >
        {analyzing ? <RefreshCw size={14} className="animate-spin" /> : <Lightbulb size={14} />}
        {analyzing ? 'Analyzing...' : 'Analyze Skill'}
      </button>
      {!hasExecutions && (
        <p className="text-xs text-deck-muted">Run the skill at least once before analyzing.</p>
      )}
    </div>
  );
}

// ── Suggestions Panel ───────────────────────────────────────────────────────

function SuggestionsPanel({ suggestions, onApply, onDismiss }: {
  suggestions: SkillSuggestion[];
  onApply: (id: string) => void;
  onDismiss: (id: string) => void;
}) {
  if (suggestions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-8">
        <Lightbulb size={20} className="text-deck-muted" />
        <p className="mt-2 text-sm text-deck-muted">No pending suggestions.</p>
        <p className="mt-1 text-xs text-deck-muted">Use "Analyze Skill" to generate improvement suggestions.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {suggestions.map((s) => (
        <div key={s.id} className="rounded-lg border border-deck-border bg-deck-bg p-4">
          <div className="flex items-start justify-between gap-2">
            <div>
              <span className="rounded bg-deck-accent/15 px-1.5 py-0.5 text-xs font-medium text-deck-accent">
                {s.suggestion_type}
              </span>
              <h4 className="mt-1 text-sm font-semibold text-deck-text">{s.title}</h4>
              {s.description && (
                <p className="mt-1 text-xs text-deck-muted">{s.description}</p>
              )}
            </div>
            <div className="flex shrink-0 gap-1">
              <button
                type="button"
                onClick={() => onApply(s.id)}
                className="flex items-center gap-1 rounded bg-deck-success/20 px-2 py-1 text-xs font-medium text-deck-success hover:bg-deck-success/30"
              >
                <Check size={12} /> Apply
              </button>
              <button
                type="button"
                onClick={() => onDismiss(s.id)}
                className="flex items-center gap-1 rounded bg-deck-border px-2 py-1 text-xs font-medium text-deck-muted hover:bg-deck-border/80"
              >
                <X size={12} /> Dismiss
              </button>
            </div>
          </div>
          {/* Diff preview */}
          <div className="mt-3 overflow-x-auto rounded border border-deck-border bg-deck-surface">
            <pre className="p-3 text-xs leading-5">
              {s.diff_content.split('\n').map((line, i) => {
                let cls = 'text-deck-text/70';
                if (line.startsWith('+') && !line.startsWith('+++')) cls = 'text-deck-success';
                else if (line.startsWith('-') && !line.startsWith('---')) cls = 'text-deck-danger';
                else if (line.startsWith('@@')) cls = 'text-deck-accent';
                return <div key={i} className={cls}>{line}</div>;
              })}
            </pre>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Execution History ───────────────────────────────────────────────────────

function ExecutionHistory({ executions, ratingExecId, ratingValue, ratingNotes, onStartRate, onSetRating, onSetNotes, onSubmitRate, onCancelRate }: {
  executions: SkillExecution[];
  ratingExecId: string | null;
  ratingValue: number;
  ratingNotes: string;
  onStartRate: (id: string) => void;
  onSetRating: (v: number) => void;
  onSetNotes: (v: string) => void;
  onSubmitRate: () => void;
  onCancelRate: () => void;
}) {
  if (executions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-8">
        <History size={20} className="text-deck-muted" />
        <p className="mt-2 text-sm text-deck-muted">No executions recorded.</p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead>
          <tr className="border-b border-deck-border text-deck-muted">
            <th className="px-3 py-2 font-medium">Date</th>
            <th className="px-3 py-2 font-medium">Duration</th>
            <th className="px-3 py-2 font-medium">Cost</th>
            <th className="px-3 py-2 font-medium">Tools</th>
            <th className="px-3 py-2 font-medium">Errors</th>
            <th className="px-3 py-2 font-medium">Outcome</th>
            <th className="px-3 py-2 font-medium">Rating</th>
          </tr>
        </thead>
        <tbody>
          {executions.map((e) => (
            <tr key={e.id} className="border-b border-deck-border/50 hover:bg-deck-surface/50">
              <td className="px-3 py-2 text-deck-text">{formatDate(e.started_at)}</td>
              <td className="px-3 py-2 text-deck-text">{e.duration_s != null ? formatDuration(e.duration_s) : '--'}</td>
              <td className="px-3 py-2 text-deck-text">{e.estimated_cost_usd != null ? formatCost(e.estimated_cost_usd) : '--'}</td>
              <td className="px-3 py-2 text-deck-text">{e.tool_call_count}</td>
              <td className="px-3 py-2 text-deck-text">{e.tool_error_count}</td>
              <td className={`px-3 py-2 font-medium ${outcomeColor(e.outcome)}`}>{e.outcome}</td>
              <td className="px-3 py-2">
                {ratingExecId === e.id ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((v) => (
                        <button
                          key={v}
                          type="button"
                          onClick={() => onSetRating(v)}
                          className={`${v <= ratingValue ? 'text-yellow-400' : 'text-deck-muted'}`}
                        >
                          <Star size={14} fill={v <= ratingValue ? 'currentColor' : 'none'} />
                        </button>
                      ))}
                    </div>
                    <input
                      type="text"
                      value={ratingNotes}
                      onChange={(ev) => onSetNotes(ev.target.value)}
                      placeholder="Notes (optional)"
                      className="w-32 rounded border border-deck-border bg-deck-bg px-1.5 py-0.5 text-xs text-deck-text"
                    />
                    <div className="flex gap-1">
                      <button type="button" onClick={onSubmitRate} disabled={ratingValue < 1}
                        className="rounded bg-deck-accent px-2 py-0.5 text-xs text-white disabled:opacity-50">Save</button>
                      <button type="button" onClick={onCancelRate}
                        className="rounded bg-deck-border px-2 py-0.5 text-xs text-deck-muted">Cancel</button>
                    </div>
                  </div>
                ) : e.user_rating ? (
                  <div className="flex items-center gap-1">
                    <div className="flex gap-0.5">
                      {[1, 2, 3, 4, 5].map((v) => (
                        <Star key={v} size={11} className={v <= e.user_rating! ? 'text-yellow-400' : 'text-deck-muted'}
                          fill={v <= e.user_rating! ? 'currentColor' : 'none'} />
                      ))}
                    </div>
                    <button type="button" onClick={() => onStartRate(e.id)}
                      className="ml-1 text-deck-muted hover:text-deck-text text-[10px]">edit</button>
                  </div>
                ) : (
                  <button type="button" onClick={() => onStartRate(e.id)}
                    className="text-deck-muted hover:text-deck-accent text-[10px]">Rate</button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Version History ─────────────────────────────────────────────────────────

function VersionHistory({ versions, onRevert }: { versions: SkillVersion[]; onRevert: (id: string) => void }) {
  if (versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-8">
        <Clock size={20} className="text-deck-muted" />
        <p className="mt-2 text-sm text-deck-muted">No versions recorded.</p>
        <p className="mt-1 text-xs text-deck-muted">Versions are created when suggestions are applied.</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {versions.map((v) => (
        <div key={v.id} className="flex items-center justify-between rounded-lg border border-deck-border bg-deck-bg px-4 py-3">
          <div>
            <div className="text-sm font-medium text-deck-text">Version {v.version_number}</div>
            <div className="text-xs text-deck-muted">
              {formatDate(v.created_at)}
              {v.change_reason && ` — ${v.change_reason}`}
            </div>
          </div>
          <button
            type="button"
            onClick={() => onRevert(v.id)}
            className="rounded bg-deck-border px-2 py-1 text-xs font-medium text-deck-muted hover:text-deck-text"
          >
            Revert
          </button>
        </div>
      ))}
    </div>
  );
}
