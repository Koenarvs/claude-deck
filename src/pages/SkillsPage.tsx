import { useState, useEffect, useCallback } from 'react';
import { RefreshCw, Sparkles, Puzzle } from 'lucide-react';

interface Skill {
  name: string;
  description: string;
  path: string;
  source: string;
}

interface ExtensionData {
  mcp: Record<string, unknown>[];
  plugins: Record<string, unknown>[];
  hooks: Record<string, unknown>;
}

type TabId = 'skills' | 'extensions';

export default function SkillsPage() {
  const [activeTab, setActiveTab] = useState<TabId>('skills');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [extensions, setExtensions] = useState<ExtensionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [skillsRes, extRes] = await Promise.all([
        fetch('/api/skills'),
        fetch('/api/extensions'),
      ]);

      if (skillsRes.ok) {
        const data: Skill[] = await skillsRes.json();
        setSkills(data);
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

  useEffect(() => {
    void fetchData();
  }, [fetchData]);

  const tabs: Array<{ id: TabId; label: string; icon: typeof Sparkles }> = [
    { id: 'skills', label: 'Skills', icon: Sparkles },
    { id: 'extensions', label: 'Extensions', icon: Puzzle },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-deck-text">Skills & Extensions</h1>
          <p className="mt-1 text-sm text-deck-muted">
            Installed Claude Code skills, MCP servers, and hooks.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void fetchData()}
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

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <RefreshCw size={20} className="animate-spin text-deck-muted" />
          <span className="ml-2 text-sm text-deck-muted">Loading...</span>
        </div>
      ) : activeTab === 'skills' ? (
        <SkillsList skills={skills} />
      ) : (
        <ExtensionsList extensions={extensions} />
      )}
    </div>
  );
}

function SkillsList({ skills }: { skills: Skill[] }) {
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
        <div
          key={skill.path}
          className="rounded-lg border border-deck-border bg-deck-surface p-4"
        >
          <h3 className="text-sm font-semibold text-deck-text">{skill.name}</h3>
          <p className="mt-1 line-clamp-2 text-xs text-deck-muted">{skill.description}</p>
          <div className="mt-2 flex items-center gap-2">
            <span className="rounded bg-deck-bg px-1.5 py-0.5 text-xs text-deck-muted">
              {skill.source}
            </span>
          </div>
        </div>
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
