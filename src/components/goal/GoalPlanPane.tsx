import { useState, useEffect, useCallback } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  Search,
  StickyNote,
  CheckSquare,
  Loader2,
} from 'lucide-react';
import { usePlanStore } from '@/stores/usePlanStore';
import { PlanRenderer } from './PlanRenderer';

interface GoalPlanPaneProps {
  goalId: string;
}

type TabId = 'plan' | 'research' | 'notes' | 'todo';

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof FileText;
  fileName?: string; // undefined = store-driven (todo)
}

const TABS: TabDef[] = [
  { id: 'plan', label: 'Plan', icon: FileText, fileName: 'plan.md' },
  { id: 'research', label: 'Research', icon: Search, fileName: 'research.md' },
  { id: 'notes', label: 'Notes', icon: StickyNote, fileName: 'notes.md' },
  { id: 'todo', label: 'To Do', icon: CheckSquare },
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

export default function GoalPlanPane({ goalId }: GoalPlanPaneProps) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [activeTab, setActiveTab] = useState<TabId>('plan');
  const [doc, setDoc] = useState<DocumentState>({ loading: false, exists: false, content: null });
  const plan = usePlanStore((state) => state.byGoalId[goalId] ?? null);

  const toggleCollapse = useCallback(() => {
    setCollapsed((prev) => {
      const next = !prev;
      writeCollapsed(next);
      return next;
    });
  }, []);

  // Fetch document whenever active tab changes (not just on mount)
  useEffect(() => {
    const tab = TABS.find((t) => t.id === activeTab);
    if (!tab?.fileName) {
      // Todo tab — no file to fetch
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
        if (!cancelled) {
          setDoc({ loading: false, exists: false, content: null });
        }
      });

    return () => { cancelled = true; };
  }, [activeTab, goalId]);

  // Sync collapse state from localStorage on mount
  useEffect(() => {
    setCollapsed(readCollapsed());
  }, []);

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
      <div className="flex items-center justify-between border-b border-deck-border px-2 py-1">
        <div className="flex gap-1">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            return (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`flex items-center gap-1 rounded px-2 py-1.5 text-xs font-medium transition-colors ${
                  activeTab === tab.id
                    ? 'bg-deck-accent/20 text-deck-accent'
                    : 'text-deck-muted hover:text-deck-text hover:bg-deck-border'
                }`}
                title={tab.label}
              >
                <Icon size={13} />
                {tab.label}
              </button>
            );
          })}
        </div>
        <button
          type="button"
          onClick={toggleCollapse}
          className="rounded p-1 text-deck-muted hover:bg-deck-border hover:text-deck-text transition-colors"
          aria-label="Collapse pane"
        >
          <ChevronRight size={16} />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-3">
        {activeTab === 'todo' ? (
          // To Do tab — from TodoWrite store
          plan ? (
            <PlanRenderer todos={plan.todos} />
          ) : (
            <EmptyState icon={CheckSquare} message="No tasks yet" detail="Tasks appear when TodoWrite is called" />
          )
        ) : doc.loading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 size={20} className="animate-spin text-deck-muted" />
          </div>
        ) : doc.exists && doc.content ? (
          <MarkdownContent content={doc.content} />
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

function MarkdownContent({ content }: { content: string }) {
  // Simple markdown rendering — headers, bold, lists, code blocks
  const lines = content.split('\n');

  return (
    <div className="prose prose-invert prose-sm max-w-none space-y-1">
      {lines.map((line, i) => {
        const trimmed = line.trimStart();

        // Headers
        if (trimmed.startsWith('### ')) return <h4 key={i} className="text-sm font-semibold text-deck-text mt-3">{trimmed.slice(4)}</h4>;
        if (trimmed.startsWith('## ')) return <h3 key={i} className="text-base font-semibold text-deck-text mt-4">{trimmed.slice(3)}</h3>;
        if (trimmed.startsWith('# ')) return <h2 key={i} className="text-lg font-bold text-deck-text mt-4">{trimmed.slice(2)}</h2>;

        // Horizontal rule
        if (trimmed.match(/^---+$/)) return <hr key={i} className="border-deck-border my-3" />;

        // List items
        if (trimmed.startsWith('- [ ] ')) return <div key={i} className="flex items-start gap-2 text-sm text-deck-text"><span className="text-deck-muted mt-0.5">☐</span><span>{trimmed.slice(6)}</span></div>;
        if (trimmed.startsWith('- [x] ')) return <div key={i} className="flex items-start gap-2 text-sm text-deck-text line-through opacity-60"><span className="text-deck-success mt-0.5">☑</span><span>{trimmed.slice(6)}</span></div>;
        if (trimmed.startsWith('- ')) return <div key={i} className="flex items-start gap-2 text-sm text-deck-text"><span className="text-deck-muted">•</span><span>{trimmed.slice(2)}</span></div>;

        // Numbered list
        const numMatch = trimmed.match(/^(\d+)\.\s+(.+)/);
        if (numMatch) return <div key={i} className="flex items-start gap-2 text-sm text-deck-text"><span className="text-deck-muted shrink-0 w-4 text-right">{numMatch[1]}.</span><span>{numMatch[2]}</span></div>;

        // Code block markers
        if (trimmed.startsWith('```')) return <div key={i} className="border-t border-deck-border mt-1" />;

        // Bold text
        if (trimmed.startsWith('**') && trimmed.endsWith('**')) return <p key={i} className="text-sm font-semibold text-deck-text">{trimmed.slice(2, -2)}</p>;

        // Empty line
        if (trimmed === '') return <div key={i} className="h-2" />;

        // Regular text
        return <p key={i} className="text-sm text-deck-text/80">{line}</p>;
      })}
    </div>
  );
}
