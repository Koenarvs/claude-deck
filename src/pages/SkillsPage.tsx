import { useState, useEffect, useCallback, useRef } from 'react';
import { RefreshCw, Sparkles, Puzzle, Bot, Clock, X } from 'lucide-react';
import SkillDetailPanel from '../components/SkillDetailPanel';
import MarkdownView from '../components/shared/MarkdownView';
import { apiGet, apiGetSafe, apiPost, apiPut, apiDelete, ApiError } from '../lib/api';

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

/** Maps HTTP errors to null (caller skips the update) while letting network errors propagate. */
const orNull = <T,>(p: Promise<T>): Promise<T | null> =>
  p.catch((err: unknown) => {
    if (err instanceof ApiError) return null;
    throw err;
  });

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
  const [viewerContent, setViewerContent] = useState<{ name: string; content: string; isSkill: boolean } | null>(null);
  const [viewerLoading, setViewerLoading] = useState(false);
  const migrated = useRef(false);

  /** Fetches skill directories from the API. */
  const fetchDirs = useCallback(async (): Promise<SkillDirEntry[]> => {
    // Non-fatal on failure — directories just won't show
    const data = await apiGetSafe<SkillDirEntry[] | null>('/api/skill-directories', null);
    if (data) {
      setSkillDirs(data);
      return data;
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
      const [skillsData, agentsData, routinesData, extData] = await Promise.all([
        orNull(apiGet<Skill[]>(`/api/skills${dirParam}`)),
        orNull(apiGet<Agent[]>(`/api/agents${dirParam}`)),
        orNull(apiGet<ScheduledTask[]>('/api/scheduled-tasks')),
        orNull(apiGet<ExtensionData>('/api/extensions')),
      ]);

      if (skillsData) setSkills(skillsData);
      if (agentsData) setAgents(agentsData);
      if (routinesData) setRoutines(routinesData);
      if (extData) setExtensions(extData);
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
          await apiPost('/api/skill-directories', { path: dirPath });
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
      await apiPost('/api/skill-directories', { path: newDir.trim() });
      setNewDir('');
      const dirs = await fetchDirs();
      void fetchData(dirs);
    } catch (err) {
      if (err instanceof ApiError) {
        const body = (typeof err.body === 'object' && err.body !== null ? err.body : {}) as {
          error?: string;
        };
        setError(body.error ?? 'Failed to add directory');
      } else {
        setError(err instanceof Error ? err.message : 'Failed to add directory');
      }
    }
  }, [newDir, fetchDirs, fetchData]);

  const removeDir = useCallback(async (id: number) => {
    try {
      await apiDelete(`/api/skill-directories/${id}`);
      const dirs = await fetchDirs();
      void fetchData(dirs);
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
  const openViewer = useCallback(async (name: string, filePath: string, isSkill: boolean) => {
    setViewerLoading(true);
    try {
      const data = await apiGet<{ content: string }>(
        `/api/skill-content?path=${encodeURIComponent(filePath)}`,
      );
      setViewerContent({ name, content: data.content, isSkill });
    } catch {
      setViewerContent({ name, content: '*Failed to load content.*', isSkill });
    } finally {
      setViewerLoading(false);
    }
  }, []);

  const openSkill = useCallback((name: string, path: string) => void openViewer(name, path, true), [openViewer]);
  const openAgent = useCallback((name: string, path: string) => void openViewer(name, path, false), [openViewer]);

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
        <SkillsList skills={skills} onViewSkill={openSkill} />
      ) : activeTab === 'agents' ? (
        <AgentsList agents={agents} onViewAgent={openAgent} />
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
          showDetailPanel={viewerContent?.isSkill ?? false}
          {...(viewerContent?.isSkill
            ? {
                onSave: async (next: string) => {
                  try {
                    await apiPut(
                      `/api/skills/${encodeURIComponent(viewerContent.name)}/content`,
                      { content: next },
                    );
                  } catch (err) {
                    if (err instanceof ApiError) {
                      const body = (
                        typeof err.body === 'object' && err.body !== null ? err.body : {}
                      ) as { error?: string };
                      throw new Error(body.error ?? `Save failed (${err.status})`);
                    }
                    throw err;
                  }
                  // Optimistic: reflect the saved content in the open viewer.
                  setViewerContent((v) => (v ? { ...v, content: next } : v));
                },
              }
            : {})}
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
  showDetailPanel,
  onSave,
}: {
  name: string;
  content: string;
  loading: boolean;
  onClose: () => void;
  showDetailPanel?: boolean;
  onSave?: (next: string) => Promise<void>;
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
        <div className="flex flex-1 flex-col overflow-y-auto px-6 py-4">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <RefreshCw size={20} className="animate-spin text-deck-muted" />
              <span className="ml-2 text-sm text-deck-muted">Loading...</span>
            </div>
          ) : (
            <div className="h-[50vh] min-h-[260px] shrink-0">
              <MarkdownView content={content} fileName={name} {...(onSave ? { onSave } : {})} />
            </div>
          )}
          {showDetailPanel && name && !loading && (
            <SkillDetailPanel skillName={name} />
          )}
        </div>
      </div>
    </div>
  );
}
