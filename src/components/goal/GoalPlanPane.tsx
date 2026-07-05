import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import MarkdownView from '../shared/MarkdownView';
import WorkspaceDiff from './WorkspaceDiff';
import {
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  FileText,
  CheckSquare,
  Activity,
  GitBranch,
  Loader2,
} from 'lucide-react';
import { apiGetSafe, apiPut, ApiError } from '@/lib/api';
import { usePlanStore } from '@/stores/usePlanStore';
import { PlanRenderer } from './PlanRenderer';
import ContextHealth from './ContextHealth';
import { onConversationUpdated } from '@/lib/conversation-events';

interface GoalPlanPaneProps {
  goalId: string;
  collapsed?: boolean;
  onCollapseChange?: (collapsed: boolean) => void;
  sessionHealth?: {
    tokensIn: number;
    tokensOut: number;
    cost: number;
    turnCount: number;
    currentContextTokens?: number;
    contextPct?: number;
  };
}

type TabId = 'health' | 'documents' | 'todo' | 'agents' | 'diff';

interface TabDef {
  id: TabId;
  label: string;
  icon: typeof FileText;
}

const TABS: TabDef[] = [
  { id: 'health', label: 'Health', icon: Activity },
  { id: 'documents', label: 'Documents', icon: FileText },
  { id: 'todo', label: 'To Do', icon: CheckSquare },
  { id: 'agents', label: 'Agents', icon: GitBranch },
  { id: 'diff', label: 'Diff', icon: GitBranch },
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
  hasMore: boolean;
  totalLines: number;
  /** Resolved fs path of a real (editable) doc; null for virtual docs (conversation.md). */
  path?: string | null;
  /** mtime at load, for save conflict detection. */
  modifiedMs?: number | null;
}

export default function GoalPlanPane({ goalId, sessionHealth, collapsed: controlledCollapsed, onCollapseChange }: GoalPlanPaneProps) {
  const [internalCollapsed, setInternalCollapsed] = useState(readCollapsed);
  const collapsed = controlledCollapsed ?? internalCollapsed;
  const [activeTab, setActiveTab] = useState<TabId>('health');
  const [doc, setDoc] = useState<DocumentState>({ loading: false, exists: false, content: null, hasMore: false, totalLines: 0 });
  const [mdFiles, setMdFiles] = useState<string[]>([]);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [loadedOffset, setLoadedOffset] = useState(0);
  const plan = usePlanStore((state) => state.byGoalId[goalId] ?? null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const toggleCollapse = useCallback(() => {
    const next = !collapsed;
    writeCollapsed(next);
    setInternalCollapsed(next);
    onCollapseChange?.(next);
  }, [collapsed, onCollapseChange]);

  // Fetch list of .md files when Documents tab is selected
  useEffect(() => {
    if (activeTab !== 'documents') return;
    let cancelled = false;

    apiGetSafe<{ files: string[] }>(`/api/goals/${goalId}/documents`, { files: [] })
      .then((data: { files: string[] }) => {
        if (cancelled) return;
        setMdFiles(data.files);
        if (!selectedFile || !data.files.includes(selectedFile)) {
          const defaultFile = data.files.includes('conversation.md')
            ? 'conversation.md'
            : data.files.includes('plan.md')
              ? 'plan.md'
              : data.files[0] ?? null;
          setSelectedFile(defaultFile);
        }
      })
      .catch(() => { if (!cancelled) setMdFiles([]); });

    return () => { cancelled = true; };
  }, [activeTab, goalId]);

  // Fetch selected document content
  useEffect(() => {
    if (activeTab !== 'documents' || !selectedFile) {
      setDoc({ loading: false, exists: false, content: null, hasMore: false, totalLines: 0 });
      return;
    }

    let cancelled = false;
    setDoc({ loading: true, exists: false, content: null, hasMore: false, totalLines: 0 });
    setLoadedOffset(0);

    const isConversation = selectedFile === 'conversation.md';
    const tailParam = isConversation ? '&tail=500' : '';

    apiGetSafe<{ exists: boolean; content: string | null; hasMore?: boolean; totalLines?: number; path?: string; modifiedMs?: number } | null>(
      `/api/goals/${goalId}/document?name=${encodeURIComponent(selectedFile)}${tailParam}`,
      null,
    )
      .then((data) => {
        if (!cancelled) {
          setDoc({
            loading: false,
            exists: data?.exists ?? false,
            content: data?.content ?? null,
            hasMore: data?.hasMore ?? false,
            totalLines: data?.totalLines ?? 0,
            path: data?.path ?? null,
            modifiedMs: data?.modifiedMs ?? null,
          });
          if (isConversation) {
            requestAnimationFrame(() => {
              if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            });
          }
        }
      })
      .catch(() => {
        if (!cancelled) setDoc({ loading: false, exists: false, content: null, hasMore: false, totalLines: 0 });
      });

    return () => { cancelled = true; };
  }, [activeTab, goalId, selectedFile]);

  // Auto-refresh when conversation.md updates via WebSocket
  useEffect(() => {
    if (activeTab !== 'documents' || selectedFile !== 'conversation.md') return;

    const unsub = onConversationUpdated(goalId, () => {
      apiGetSafe<{ exists: boolean; content: string | null; hasMore?: boolean; totalLines?: number } | null>(
        `/api/goals/${goalId}/document?name=conversation.md&tail=500`,
        null,
      )
        .then((data) => {
          if (data) {
            setDoc({
              loading: false,
              exists: data.exists,
              content: data.content,
              hasMore: data.hasMore ?? false,
              totalLines: data.totalLines ?? 0,
            });
            setLoadedOffset(0);
            requestAnimationFrame(() => {
              if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            });
          }
        })
        .catch(() => {});
    });

    return unsub;
  }, [activeTab, goalId, selectedFile]);

  const loadMore = useCallback(() => {
    if (!selectedFile || !doc.hasMore) return;
    const newOffset = loadedOffset + 500;

    apiGetSafe<{ exists: boolean; content: string | null; hasMore?: boolean } | null>(
      `/api/goals/${goalId}/document?name=${encodeURIComponent(selectedFile)}&tail=500&offset=${newOffset}`,
      null,
    )
      .then((data) => {
        if (data?.content) {
          setDoc(prev => ({
            ...prev,
            content: data.content + '\n' + (prev.content ?? ''),
            hasMore: data.hasMore ?? false,
          }));
          setLoadedOffset(newOffset);
        }
      })
      .catch(() => {});
  }, [goalId, selectedFile, doc.hasMore, loadedOffset]);

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
      <div ref={scrollRef} className="flex-1 overflow-y-auto min-h-0 px-4 py-3">
        {activeTab === 'health' ? (
          <ContextHealth
            tokensIn={sessionHealth?.tokensIn ?? 0}
            tokensOut={sessionHealth?.tokensOut ?? 0}
            cost={sessionHealth?.cost ?? 0}
            turnCount={sessionHealth?.turnCount ?? 0}
            contextPct={sessionHealth?.contextPct}
          />
        ) : activeTab === 'todo' ? (
          plan ? (
            <PlanRenderer todos={plan.todos} />
          ) : (
            <EmptyState icon={CheckSquare} message="No tasks yet" detail="Tasks appear when TodoWrite is called" />
          )
        ) : activeTab === 'agents' ? (
          <AgentTree goalId={goalId} />
        ) : activeTab === 'documents' ? (
          <DocumentsView
            mdFiles={mdFiles}
            selectedFile={selectedFile}
            onSelectFile={setSelectedFile}
            doc={doc}
            hasMore={doc.hasMore ?? false}
            onLoadMore={loadMore}
            {...(doc.path
              ? {
                  onSaveDoc: async (next: string) => {
                    let saved: { modifiedMs?: number };
                    try {
                      saved = await apiPut<{ modifiedMs?: number }>('/api/file', {
                        path: doc.path,
                        content: next,
                        ...(doc.modifiedMs != null ? { baseModifiedMs: doc.modifiedMs } : {}),
                      });
                    } catch (err) {
                      if (err instanceof ApiError) {
                        const body = (
                          typeof err.body === 'object' && err.body !== null ? err.body : {}
                        ) as { error?: string };
                        throw new Error(body.error ?? `Save failed (${err.status})`);
                      }
                      throw err;
                    }
                    setDoc((prev) => ({
                      ...prev,
                      content: next,
                      modifiedMs: saved.modifiedMs ?? prev.modifiedMs ?? null,
                    }));
                  },
                }
              : {})}
          />
        ) : activeTab === 'diff' ? (
          <WorkspaceDiff goalId={goalId} />
        ) : null}
      </div>
    </div>
  );
}

// ── Documents View ─────────────────────────────────────────────────────────────

interface DocumentsViewProps {
  mdFiles: string[];
  selectedFile: string | null;
  onSelectFile: (file: string) => void;
  doc: DocumentState;
  hasMore: boolean;
  onLoadMore: () => void;
  /** Save handler for the editable (real-file) doc; omit ⇒ read-only viewer. */
  onSaveDoc?: (next: string) => Promise<void>;
}

function DocumentsView({ mdFiles, selectedFile, onSelectFile, doc, hasMore, onLoadMore, onSaveDoc }: DocumentsViewProps) {
  if (mdFiles.length === 0) {
    return <EmptyState icon={FileText} message="No documents found" detail="Place .md files in the goal's working directory" />;
  }

  return (
    <div>
      {/* File picker */}
      <div className="mb-3">
        <select
          value={selectedFile ?? ''}
          onChange={(e) => onSelectFile(e.target.value)}
          className="w-full rounded border border-deck-border bg-deck-bg px-2 py-1.5 text-xs text-deck-text focus:border-deck-accent focus:outline-none"
        >
          {mdFiles.map((f) => (
            <option key={f} value={f}>{f}</option>
          ))}
        </select>
      </div>

      {/* Load more button */}
      {hasMore && (
        <button
          type="button"
          onClick={onLoadMore}
          className="w-full text-center text-xs text-deck-muted hover:text-deck-accent py-2 mb-3 border-b border-deck-border transition-colors"
        >
          Load earlier messages...
        </button>
      )}

      {/* Document content */}
      {doc.loading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 size={20} className="animate-spin text-deck-muted" />
        </div>
      ) : doc.exists && doc.content && doc.path ? (
        // Real file → editable via the shared MarkdownView (saves through PUT /api/file).
        <div className="h-full min-h-[260px]">
          <MarkdownView
            content={doc.content}
            {...(selectedFile ? { fileName: selectedFile } : {})}
            {...(onSaveDoc ? { onSave: onSaveDoc } : {})}
          />
        </div>
      ) : doc.exists && doc.content ? (
        // Virtual doc (conversation.md) → read-only prose with the pane's own scroll.
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
        <EmptyState icon={FileText} message={`${selectedFile ?? 'File'} not found`} detail="File may not exist yet" />
      )}
    </div>
  );
}

// ── Shared Components ──────────────────────────────────────────────────────────

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

    apiGetSafe<AgentSession[]>(`/api/sessions?goal_id=${goalId}&limit=200`, [])
      .then((sessions: AgentSession[]) => {
        if (cancelled || !Array.isArray(sessions)) return;

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
        {depth > 0 && <span className="text-deck-muted text-xs">&#9492;</span>}
        <span className={`h-2 w-2 shrink-0 rounded-full ${isActive ? 'bg-deck-success animate-pulse' : 'bg-deck-muted'}`} />
        <span className="text-sm font-medium text-deck-text truncate" title={s.id}>
          {name}
        </span>
        <span className={`text-[10px] font-medium rounded px-1.5 py-0.5 ${
          isActive
            ? 'bg-deck-success/15 text-deck-success'
            : 'bg-deck-muted/15 text-deck-muted'
        }`}>
          {isActive ? 'Active' : 'Done'}
        </span>
        <span className="flex-1" />
        {s.stream_event_count > 0 && (
          <span className="text-[10px] text-deck-muted">
            {s.stream_event_count}t
          </span>
        )}
      </div>
      {node.children.map((child) => (
        <AgentNodeRow key={child.session.id} node={child} depth={depth + 1} />
      ))}
    </>
  );
}
