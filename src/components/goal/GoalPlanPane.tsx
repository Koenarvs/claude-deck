import { useState, useEffect, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  Search,
  StickyNote,
  CheckSquare,
  Activity,
  GitBranch,
  Loader2,
} from 'lucide-react';
import { usePlanStore } from '@/stores/usePlanStore';
import { PlanRenderer } from './PlanRenderer';
import ContextHealth from './ContextHealth';

interface GoalPlanPaneProps {
  goalId: string;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  sessionHealth?: {
    tokensIn: number;
    tokensOut: number;
    cost: number;
    turnCount: number;
  };
}

type TabId = 'health' | 'plan' | 'research' | 'notes' | 'todo' | 'agents';

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof FileText;
  fileName?: string;
}

const TABS: TabDef[] = [
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'plan', label: 'Plan', icon: FileText, fileName: 'plan.md' },
  { id: 'research', label: 'Research', icon: Search, fileName: 'research.md' },
  { id: 'notes', label: 'Notes', icon: StickyNote, fileName: 'notes.md' },
  { id: 'todo', label: 'To Do', icon: CheckSquare },
  { id: 'agents', label: 'Agents', icon: GitBranch },
];

const COLLAPSE_KEY = 'claude-deck:plan-pane-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSE_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeCollapsed(value: boolean): void {
  try {
    localStorage.setItem(COLLAPSE_KEY, value ? 'true' : 'false');
  } catch {}
}

interface DocumentState {
  loading: boolean;
  exists: boolean;
  content: string | null;
}

export default function GoalPlanPane({ goalId, sessionHealth, collapsed: controlledCollapsed, onCollapseChange }: GoalPlanPaneProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(readCollapsed);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const [activeTab, setActiveTab] = useState<TabId>('health');
  const [doc, setDoc] = useState<DocumentState>({ loading: false, exists: false, content: null });
  const plan = usePlanStore((state) => state.byGoalId[goalId] ?? null);

  const toggleCollapse = useCallback(() => {
    const next = !collapsed;
    writeCollapsed(next);
    setInternalCollapsed(next);
    onCollapseChange?.(next);
  }, [collapsed, onCollapseChange]);

  // Fetch document whenever active tab changes
  useEffect(() => {
    const tab = TABS.find((t) => t.id === activeTab);
    if (!tab?.fileName) {
      setDoc({ loading: false, exists: false, content: null });
      return;
    }

    let cancelled = false;
    setDoc({ loading: true, exists: false, content: null });

    fetch(`/api/goals/${goalId}/document?name=${encodeURIComponent(tab.fileName)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((data: { exists: boolean; content: string | null } | null) => {
        if (!cancelled) {
          setDoc({
            loading: false,
            exists: data?.exists ?? false,
            content: data?.content ?? null,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setDoc({ loading: false, exists: false, content: null });
      });

    return () => { cancelled = true; };
  }, [activeTab, goalId]);

  useEffect(() => { setInternalCollapsed(readCollapsed()); }, []);

  if (collapsed) {
    return (
      <div
        className="flex h-full w-10 flex-col items-center border-l border-deck-border bg-deck-surface pt-3"
        data-testid="plan-pane-collapsed"
      >
        <button
          type="button"
          onClick={toggleCollapse}
          className="rounded p-1 text-deck-muted hover:bg-deck-border hover:text-deck-text transition-colors"
          aria-label="Expand pane"
        >
          <ChevronLeft size={16} />
        </button>
        <div className="mt-3">
          <ClipboardList size={16} className="text-deck-muted" />
        </div>
      </div>
    );
  }

  const currentTab = TABS.find((t) => t.id === activeTab);

  return (
    <div
      className="flex h-full w-full flex-col border-l border-deck-border bg-deck-surface"
      data-testid="plan-pane-expanded"
    >
      {/* Header with tabs */}
      <div className="flex items-center justify-between border-b border-deck-border px-1 py-1 shrink-0">
        <div className="flex gap-0.5 overflow-x-auto">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium whitespace-nowrap transition-colors ${
                  activeTab === tab.id
                    ? 'bg-deck-accent/20 text-deck-accent'
                    : 'text-deck-muted hover:text-deck-text hover:bg-deck-border'
                }`}
                title={tab.label}
              >
                <Icon size={12} />
                {tab.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={toggleCollapse}
          className="shrink-0 rounded p-1 text-deck-muted hover:bg-deck-border hover:text-deck-text transition-colors"
          aria-label="Collapse pane"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto min-h-0 px-4 py-3">
        {activeTab === 'health' ? (
          <ContextHealth
            tokensIn={sessionHealth?.tokensIn ?? 0}
            tokensOut={sessionHealth?.tokensOut ?? 0}
            cost={sessionHealth?.cost ?? 0}
            turnCount={sessionHealth?.turnCount ?? 0}
          />
        ) : activeTab === 'todo' ? (
          plan ? (
            <PlanRenderer todos={plan.todos} />
          ) : (
            <EmptyState icon={CheckSquare} message="No tasks yet" detail="Tasks appear when TodoWrite is called" />
          )
        ) : activeTab === 'agents' ? (
          <AgentTree goalId={goalId} />
        ) : doc.loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-deck-muted" />
          </div>
        ) : doc.exists && doc.content ? (
          <div className="prose prose-invert prose-sm max-w-none
            prose-headings:text-deck-text prose-p:text-deck-text/80
            prose-a:text-deck-accent prose-strong:text-deck-text
            prose-code:text-deck-accent prose-code:bg-deck-bg prose-code:px-1 prose-code:rounded
            prose-pre:bg-deck-bg prose-pre:border prose-pre:border-deck-border
            prose-table:border-collapse
            prose-th:border prose-th:border-deck-border prose-th:bg-deck-bg prose-th:px-3 prose-th:py-1.5 prose-th:text-left prose-th:text-xs prose-th:text-deck-muted
            prose-td:border prose-td:border-deck-border prose-td:px-3 prose-td:py-1.5 prose-td:text-sm
            prose-li:text-deck-text/80
            prose-hr:border-deck-border
            prose-blockquote:border-deck-accent/40 prose-blockquote:text-deck-muted
          ">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{doc.content}</ReactMarkdown>
          </div>
        ) : (
          <EmptyState
            icon={currentTab?.icon ?? FileText}
            message={`No ${currentTab?.label.toLowerCase() ?? 'document'} found`}
            detail={`Place ${currentTab?.fileName ?? 'file'} in the goal's working directory`}
          />
        )}
      </div>
    </div>
  );
}

function EmptyState({ icon: Icon, message, detail }: { icon: typeof FileText; message: string; detail: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-8 text-deck-muted">
      <Icon size={24} className="mb-2 opacity-40" />
      <p className="text-sm">{message}</p>
      <p className="mt-1 text-xs opacity-60">{detail}</p>
    </div>
  );
}

// ── Agent Tree ──────────────────────────────────────────────────────────────

interface AgentSession {
  id: string;
  display_name: string | null;
  parent_session_id: string | null;
  origin: string;
  model: string | null;
  total_cost_usd: number | null;
  stream_event_count: number;
  started_at: number | null;
  ended_at: number | null;
}

interface AgentNode {
  session: AgentSession;
  children: AgentNode[];
}

function AgentTree({ goalId }: { goalId: string }) {
  const [tree, setTree] = useState<AgentNode[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    fetch(`/api/sessions?goal_id=${goalId}&limit=200`)
      .then((r) => (r.ok ? r.json() : []))
      .then((sessions: AgentSession[]) => {
        if (cancelled || !Array.isArray(sessions)) return;

        // Build tree
        const byId = new Map(sessions.map((s) => [s.id, s]));
        const childrenMap = new Map<string, AgentSession[]>();
        const roots: AgentSession[] = [];

        for (const s of sessions) {
          if (s.parent_session_id && byId.has(s.parent_session_id)) {
            const siblings = childrenMap.get(s.parent_session_id) ?? [];
            siblings.push(s);
            childrenMap.set(s.parent_session_id, siblings);
          } else {
            roots.push(s);
          }
        }

        function buildNode(s: AgentSession): AgentNode {
          const kids = (childrenMap.get(s.id) ?? [])
            .sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0));
          return { session: s, children: kids.map(buildNode) };
        }

        setTree(roots.sort((a, b) => (a.started_at ?? 0) - (b.started_at ?? 0)).map(buildNode));
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });

    return () => { cancelled = true; };
  }, [goalId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 size={20} className="animate-spin text-deck-muted" />
      </div>
    );
  }

  if (tree.length === 0) {
    return <EmptyState icon={GitBranch} message="No sessions" detail="Sessions appear when the goal runs" />;
  }

  return (
    <div className="space-y-1">
      {tree.map((node) => (
        <AgentNodeRow key={node.session.id} node={node} depth={0} />
      ))}
    </div>
  );
}

function AgentNodeRow({ node, depth }: { node: AgentNode; depth: number }) {
  const s = node.session;
  const isActive = s.ended_at == null;
  const name = s.display_name ?? s.id.slice(0, 12) + '...';

  return (
    <>
      <div
        className="flex items-center gap-2 rounded px-2 py-1.5 hover:bg-deck-border/50 transition-colors"
        style={{ paddingLeft: `${8 + depth * 16}px` }}
      >
        {/* Connector line for children */}
        {depth > 0 && <span className="text-deck-muted text-xs">└</span>}

        {/* Status dot */}
        <span className={`h-2 w-2 shrink-0 rounded-full ${isActive ? 'bg-deck-success animate-pulse' : 'bg-deck-muted'}`} />

        {/* Name */}
        <span className="text-sm font-medium text-deck-text truncate" title={s.id}>
          {name}
        </span>

        {/* Status label */}
        <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${
          isActive
            ? 'bg-deck-success/15 text-deck-success'
            : 'bg-deck-muted/15 text-deck-muted'
        }`}>
          {isActive ? 'Active' : 'Done'}
        </span>

        {/* Spacer */}
        <span className="flex-1" />

        {/* Cost badge */}
        {s.total_cost_usd != null && s.total_cost_usd > 0 && (
          <span className="text-[10px] font-mono text-deck-muted">
            ${s.total_cost_usd.toFixed(4)}
          </span>
        )}

        {/* Turn count */}
        {s.stream_event_count > 0 && (
          <span className="text-[10px] text-deck-muted">
            {s.stream_event_count}t
          </span>
        )}
      </div>

      {/* Render children */}
      {node.children.map((child) => (
        <AgentNodeRow key={child.session.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}
