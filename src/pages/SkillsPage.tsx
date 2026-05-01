import { useState, useEffect, useCallback, useRef } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { RefreshCw, Sparkles, Puzzle, Bot, Clock, X } from 'lucide-react';

interface Skill {
  name: string;
  description: string;
  path: string;
  source: string;
  scope: string;
  type: string;
}

interface Agent {
  name: string;
  description: string;
  path: string;
  scope: string;
  type: string;
}

interface ScheduledTask {
  id: string;
  name: string;
  cron_expr: string;
  enabled: boolean;
  last_run_at: number | null;
  next_run_at: number | null;
  created_at: number;
}

interface SkillDirEntry {
  id: number;
  path: string;
  label: string | null;
  enabled: boolean;
  created_at: string;
}

interface ExtensionData {
  mcp: Record<string, unknown>[];
  plugins: Record<string, unknown>[];
  hooks: Record<string, unknown>;
}

type TabId = 'skills' | 'agents' | 'routines' | 'extensions';

const LEGACY_STORAGE_KEY = 'claude-deck:skill-dirs';

export default function SkillsPage() {
  const [activeTab, setActiveTab] = useState<TabId>('skills');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [agents, setAgents] = useState<Agent[]>([]);
  const [routines, setRoutines] = useState<ScheduledTask[]>([]);
  const [extensions, setExtensions] = useState<ExtensionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [skillDirs, setSkillDirs] = useState<SkillDirEntry[]>([]);
  const [newDir, setNewDir] = useState('');
  const [viewerContent, setViewerContent] = useState<{ name: string; content: string } | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const migrated = useRef(false);

  /** Fetches skill directories from the API. */
  const fetchDirs = useCallback(async (): Promise<SkillDirEntry[]> => {
    try {
      const res = await fetch('/api/skill-directories');
      if (res.ok) {
        const data: SkillDirEntry[] = await res.json();
        setSkillDirs(data);
        return data;
      }
    } catch {
      // Non-fatal — directories just won't show
    }
    return [];
  }, []);

  /** Fetches skills, agents, routines, and extensions. */
  const fetchData = useCallback(async (dirs: SkillDirEntry[] = []) => {
    setLoading(true);
    setError(null);
    try {
      const dirPaths = dirs.map((d) => d.path);
      const dirParam = dirPaths.length > 0 ? `?dir=${encodeURIComponent(dirPaths.join(','))}` : '';
      const [skillsRes, agentsRes, routinesRes, extRes] = await Promise.all([
        fetch(`/api/skills${dirParam}`),
        fetch(`/api/agents${dirParam}`),
        fetch('/api/scheduled-tasks'),
        fetch('/api/extensions'),
      ]);

      if (skillsRes.ok) {
        const data: Skill[] = await skillsRes.json();
        setSkills(data);
      }

      if (agentsRes.ok) {
        const data: Agent[] = await agentsRes.json();
        setAgents(data);
      }

      if (routinesRes.ok) {
        const data: ScheduledTask[] = await routinesRes.json();
        setRoutines(data);
      }

      if (extRes.ok) {
        const data: ExtensionData = await extRes.json();
        setExtensions(data);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, []);

  /** Migrates legacy localStorage dirs to the API (one-time, on first load). */
  const migrateLegacyDirs = useCallback(async (currentDirs: SkillDirEntry[]) => {
    if (migrated.current) return currentDirs;
    migrated.current = true;

    try {
      const raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return currentDirs;

      const legacyDirs: string[] = JSON.parse(raw);
      if (!Array.isArray(legacyDirs) || legacyDirs.length === 0) return currentDirs;

      // Only migrate dirs not already in the DB
      const existingPaths = new Set(currentDirs.map((d) => d.path));
      const toMigrate = legacyDirs.filter((d) => !existingPaths.has(d));

      for (const dirPath of toMigrate) {
        try {
          await fetch('/api/skill-directories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path: dirPath }),
          });
        } catch {
          // Best-effort migration — skip failures
        }
      }

      // Clear localStorage after successful migration
      localStorage.removeItem(LEGACY_STORAGE_KEY);

      // Re-fetch to get the updated list
      return await fetchDirs();
    } catch {
      return currentDirs;
    }
  }, [fetchDirs]);

  const addDir = useCallback(async () => {
    if (!newDir.trim()) return;
    try {
      const res = await fetch('/api/skill-directories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: newDir.trim() }),
      });
      if (res.ok) {
        setNewDir('');
        const dirs = await fetchDirs();
        void fetchData(dirs);
      } else {
        const data = await res.json();
        setError(data.error ?? 'Failed to add directory');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add directory');
    }
  }, [newDir, fetchDirs, fetchData]);

  const removeDir = useCallback(async (id: number) => {
    try {
      const res = await fetch(`/api/skill-directories/${id}`, { method: 'DELETE' });
      if (res.ok) {
        const dirs = await fetchDirs();
        void fetchData(dirs);
      }
    } catch {
      // Non-fatal
    }
  }, [fetchDirs, fetchData]);

  useEffect(() => {
    async function init() {
      let dirs = await fetchDirs();
      dirs = await migrateLegacyDirs(dirs);
      void fetchData(dirs);
    }
    void init();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only on mount
  }, []);

  /** Opens the skill/agent viewer modal by fetching file content. */
  const openViewer = useCallback(async (name: string, filePath: string) => {
    setViewerLoading(true);
    try {
      const res = await fetch(`/api/skill-content?path=${encodeURIComponent(filePath)}`);
      if (res.ok) {
        const data: { content: string } = await res.json();
        setViewerContent({ name, content: data.content });
      } else {
        setViewerContent({ name, content: '*Failed to load content.*' });
      }
    } catch {
      setViewerContent({ name, content: '*Failed to load content.*' });
    } finally {
      setViewerLoading(false);
    }
  }, []);

  const tabs: Array<{ id: TabId; label: string; icon: typeof Sparkles }> = [
    { id: 'skills', label: 'Skills', icon: Sparkles },
    { id: 'agents', label: 'Agents', icon: Bot },
    { id: 'routines', label: 'Routines', icon: Clock },
    { id: 'extensions', label: 'Extensions', icon: Puzzle },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-deck-text">Skills & Extensions</h1>
          <p className="mt-1 text-sm text-deck-muted">
            Installed Claude Code skills, agents, routines, and extensions.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchData(skillDirs)}
          disabled={loading}
          className="rounded-md border border-deck-border p-2 text-deck-muted hover:bg-deck-border hover:text-deck-text disabled:opacity-50"
          aria-label="Refresh"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {error && (
        <div className="rounded-md border border-deck-danger/30 bg-deck-danger/10 px-4 py-3 text-sm text-deck-danger">
          {error}
        </div>
      )}

      {/* Tab bar */}
      <div className="flex gap-1 border-b border-deck-border">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 border-b-2 px-4 py-2 text-sm font-medium transition-colors ${
                activeTab === tab.id
                  ? 'border-deck-accent text-deck-accent'
                  : 'border-transparent text-deck-muted hover:text-deck-text'
              }`}
            >
              <Icon size={16} />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'skills' && (
        <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
          <h3 className="mb-2 text-sm font-medium text-deck-text">Scan Directories</h3>
          <div className="flex gap-2">
            <input
              type="text"
              value={newDir}
              onChange={(e) => setNewDir(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void addDir(); }}
              placeholder="e.g. C:\CTDW Repository\cpt-dwdi"
              className="flex-1 rounded border border-deck-border bg-deck-bg px-3 py-1.5 text-sm text-deck-text placeholder:text-deck-muted"
            />
            <button
              type="button"
              onClick={() => void addDir()}
              className="rounded bg-deck-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-deck-accent-hover"
            >
              Add
            </button>
          </div>
          {skillDirs.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2">
              {skillDirs.map((dir) => (
                <span key={dir.id} className="flex items-center gap-1 rounded-full bg-deck-border px-3 py-1 text-xs text-deck-text">
                  {dir.label ?? dir.path}
                  <button type="button" onClick={() => void removeDir(dir.id)} className="ml-1 text-deck-muted hover:text-deck-danger">x</button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw size={20} className="animate-spin text-deck-muted" />
          <span className="ml-2 text-sm text-deck-muted">Loading...</span>
        </div>
      ) : activeTab === 'skills' ? (
        <SkillsList skills={skills} onViewSkill={openViewer} />
      ) : activeTab === 'agents' ? (
        <AgentsList agents={agents} onViewAgent={openViewer} />
      ) : activeTab === 'routines' ? (
        <RoutinesList routines={routines} />
      ) : (
        <ExtensionsList extensions={extensions} />
      )}

      {/* Skill/Agent content viewer modal */}
      {(viewerContent || viewerLoading) && (
        <SkillViewerModal
          name={viewerContent?.name ?? ''}
          content={viewerContent?.content ?? ''}
          loading={viewerLoading}
          onClose={() => { setViewerContent(null); setViewerLoading(false); }}
        />
      )}
    </div>
  );
}

function SkillsList({ skills, onViewSkill }: { skills: Skill[]; onViewSkill: (name: string, path: string) => void }) {
  if (skills.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-12">
        <Sparkles size={24} className="text-deck-muted" />
        <p className="mt-2 text-sm text-deck-muted">No skills found.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {skills.map((skill) => (
        <button
          key={skill.path}
          type="button"
          onClick={() => onViewSkill(skill.name, skill.path)}
          className="rounded-lg border border-deck-border bg-deck-surface p-4 text-left transition-colors hover:border-deck-accent/50 hover:bg-deck-surface/80"
        >
          <h3 className="text-sm font-semibold text-deck-text">{skill.name}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-deck-muted">{skill.description}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="rounded bg-deck-bg px-1.5 py-0.5 text-xs text-deck-muted">
              {skill.source ?? skill.scope}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

function ExtensionsList({ extensions }: { extensions: ExtensionData | null }) {
  if (!extensions) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-12">
        <Puzzle size={24} className="text-deck-muted" />
        <p className="mt-2 text-sm text-deck-muted">No extension data available.</p>
      </div>
    );
  }

  const mcpServers = extensions.mcp ?? [];
  const plugins = extensions.plugins ?? [];
  const hookTypes = Object.keys(extensions.hooks ?? {});

  return (
    <div className="space-y-6">
      {/* MCP Servers */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-deck-text">
          MCP Servers ({mcpServers.length})
        </h3>
        {mcpServers.length === 0 ? (
          <p className="text-xs text-deck-muted">No MCP servers configured.</p>
        ) : (
          <div className="space-y-2">
            {mcpServers.map((server, i) => (
              <div
                key={i}
                className="rounded-md border border-deck-border bg-deck-bg px-3 py-2 font-mono text-xs text-deck-text"
              >
                {JSON.stringify(server, null, 2)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Plugins */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-deck-text">
          Plugins ({plugins.length})
        </h3>
        {plugins.length === 0 ? (
          <p className="text-xs text-deck-muted">No plugins installed.</p>
        ) : (
          <div className="space-y-2">
            {plugins.map((plugin, i) => (
              <div
                key={i}
                className="rounded-md border border-deck-border bg-deck-bg px-3 py-2 font-mono text-xs text-deck-text"
              >
                {JSON.stringify(plugin, null, 2)}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Hooks */}
      <div>
        <h3 className="mb-2 text-sm font-semibold text-deck-text">
          Hook Types ({hookTypes.length})
        </h3>
        {hookTypes.length === 0 ? (
          <p className="text-xs text-deck-muted">No hooks registered.</p>
        ) : (
          <div className="flex flex-wrap gap-2">
            {hookTypes.map((type) => (
              <span
                key={type}
                className="rounded-full bg-deck-accent/10 px-3 py-1 text-xs font-medium text-deck-accent"
              >
                {type}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function AgentsList({ agents, onViewAgent }: { agents: Agent[]; onViewAgent: (name: string, path: string) => void }) {
  if (agents.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-12">
        <Bot size={24} className="text-deck-muted" />
        <p className="mt-2 text-sm text-deck-muted">No agents found.</p>
        <p className="mt-1 text-xs text-deck-muted">Place .md files in ~/.claude/agents/ or .claude/agents/</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {agents.map((agent) => (
        <button
          key={agent.path}
          type="button"
          onClick={() => onViewAgent(agent.name, agent.path)}
          className="rounded-lg border border-deck-border bg-deck-surface p-4 text-left transition-colors hover:border-deck-accent/50 hover:bg-deck-surface/80"
        >
          <div className="flex items-center gap-2">
            <Bot size={14} className="shrink-0 text-deck-accent" />
            <h3 className="text-sm font-semibold text-deck-text">{agent.name}</h3>
          </div>
          <p className="mt-1 line-clamp-2 text-xs text-deck-muted">{agent.description}</p>
          <div className="mt-2">
            <span className="rounded bg-deck-bg px-1.5 py-0.5 text-xs text-deck-muted">
              {agent.scope}
            </span>
          </div>
        </button>
      ))}
    </div>
  );
}

function formatCron(expr: string): string {
  // Simple human-readable cron descriptions
  const parts = expr.split(/\s+/);
  if (parts.length < 5) return expr;
  const [min, hour, dom, mon, dow] = parts;
  if (min === '*' && hour === '*') return 'Every minute';
  if (hour === '*' && min?.startsWith('*/')) return `Every ${min.slice(2)} minutes`;
  if (dom === '*' && mon === '*' && dow === '*') return `Daily at ${hour}:${min?.padStart(2, '0')}`;
  if (dom === '*' && mon === '*' && dow === '1-5') return `Weekdays at ${hour}:${min?.padStart(2, '0')}`;
  return expr;
}

function formatTimestamp(ts: number | null): string {
  if (!ts) return '--';
  return new Date(ts).toLocaleString();
}

function RoutinesList({ routines }: { routines: ScheduledTask[] }) {
  if (routines.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center rounded-lg border border-dashed border-deck-border py-12">
        <Clock size={24} className="text-deck-muted" />
        <p className="mt-2 text-sm text-deck-muted">No routines configured.</p>
        <p className="mt-1 text-xs text-deck-muted">Create scheduled tasks to automate goals on a cron schedule.</p>
      </div>
    );
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {routines.map((task) => (
        <div
          key={task.id}
          className="rounded-lg border border-deck-border bg-deck-surface p-4"
        >
          <div className="flex items-center gap-2">
            <Clock size={14} className="shrink-0 text-deck-accent" />
            <h3 className="text-sm font-semibold text-deck-text truncate">{task.name}</h3>
          </div>
          <p className="mt-1 text-xs text-deck-muted font-mono">{task.cron_expr}</p>
          <p className="text-xs text-deck-muted">{formatCron(task.cron_expr)}</p>
          <div className="mt-2 space-y-1 text-xs text-deck-muted">
            <div className="flex justify-between">
              <span>Next run</span>
              <span>{formatTimestamp(task.next_run_at)}</span>
            </div>
            <div className="flex justify-between">
              <span>Last run</span>
              <span>{formatTimestamp(task.last_run_at)}</span>
            </div>
          </div>
          <div className="mt-2">
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${
              task.enabled
                ? 'bg-deck-success/15 text-deck-success'
                : 'bg-deck-muted/15 text-deck-muted'
            }`}>
              {task.enabled ? 'Active' : 'Paused'}
            </span>
          </div>
        </div>
      ))}
    </div>
  );
}

function SkillViewerModal({
  name,
  content,
  loading,
  onClose,
}: {
  name: string;
  content: string;
  loading: boolean;
  onClose: () => void;
}) {
  // Close on Escape key
  useEffect(() => {
    function handleKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      data-testid="skill-viewer-modal"
    >
      <div className="relative mx-4 flex max-h-[80vh] w-full max-w-3xl flex-col rounded-lg border border-deck-border bg-deck-surface shadow-xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-deck-border px-6 py-4">
          <h2 className="text-lg font-semibold text-deck-text">{name}</h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-deck-muted hover:bg-deck-border hover:text-deck-text transition-colors"
            aria-label="Close viewer"
          >
            <X size={18} />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw size={20} className="animate-spin text-deck-muted" />
              <span className="ml-2 text-sm text-deck-muted">Loading...</span>
            </div>
          ) : (
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
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
