import type { ToolUsage } from '../../lib/analytics-api';
import { Empty, ChartError } from './shared';

// Tool category taxonomy (mirrors cc-lens)
const TOOL_CATEGORIES: Record<string, string> = {
  Read: 'file-io', Write: 'file-io', Edit: 'file-io', Glob: 'file-io', Grep: 'file-io', NotebookEdit: 'file-io',
  Bash: 'shell',
  Agent: 'agent', Task: 'agent', TaskCreate: 'agent', TaskUpdate: 'agent', TaskList: 'agent', TaskOutput: 'agent', TaskStop: 'agent', TaskGet: 'agent',
  WebSearch: 'web', WebFetch: 'web',
  EnterPlanMode: 'planning', ExitPlanMode: 'planning', AskUserQuestion: 'planning',
  TodoWrite: 'todo',
  Skill: 'skill', ToolSearch: 'skill', ListMcpResourcesTool: 'skill', ReadMcpResourceTool: 'skill',
};

const CATEGORY_LABELS: Record<string, string> = {
  'file-io': 'File I/O',
  'shell': 'Shell',
  'agent': 'Agents',
  'web': 'Web',
  'planning': 'Planning',
  'todo': 'Tasks',
  'skill': 'Skills',
  'mcp': 'MCP',
  'other': 'Other',
};

const CATEGORY_COLORS: Record<string, string> = {
  'file-io': '#43949B',
  'shell': '#D38235',
  'agent': '#51A443',
  'web': '#8B5CF6',
  'planning': '#EC4899',
  'todo': '#F59E0B',
  'skill': '#06B6D4',
  'mcp': '#1A6954',
  'other': '#6B7280',
};

function categorize(toolName: string): string {
  if (toolName.startsWith('mcp__')) return 'mcp';
  return TOOL_CATEGORIES[toolName] ?? 'other';
}

export function categorizeTools(tools: ToolUsage[]): Array<{ category: string; label: string; color: string; count: number }> {
  const cats = new Map<string, number>();
  for (const t of tools) {
    const cat = categorize(t.name);
    cats.set(cat, (cats.get(cat) ?? 0) + t.count);
  }
  return [...cats.entries()]
    .map(([category, count]) => ({
      category,
      label: CATEGORY_LABELS[category] ?? category,
      color: CATEGORY_COLORS[category] ?? '#6B7280',
      count,
    }))
    .sort((a, b) => b.count - a.count);
}

export function ToolUsagePanel({ toolUsage, error }: { toolUsage: ToolUsage[]; error: boolean }) {
  const categoryData = categorizeTools(toolUsage);
  return (
    <div className="rounded-md border border-line bg-card p-4">
      <h2 className="mb-4 text-sm font-medium text-dim">Tool Usage by Category</h2>
      {error ? (
        <ChartError />
      ) : categoryData.length > 0 ? (
        <div className="space-y-2">
          {categoryData.map((cat) => (
            <div key={cat.category} className="flex items-center gap-3">
              <span className="w-16 text-right text-xs text-dim">{cat.label}</span>
              <div className="flex-1 h-6 bg-inset rounded overflow-hidden">
                <div
                  className="h-full rounded transition-all"
                  style={{
                    width: `${(cat.count / Math.max(...categoryData.map((c) => c.count))) * 100}%`,
                    backgroundColor: cat.color,
                  }}
                />
              </div>
              <span className="w-10 text-right mono-tabular text-[10px] text-faint">{cat.count}</span>
            </div>
          ))}
        </div>
      ) : (
        <Empty text="No tool usage data yet" />
      )}
    </div>
  );
}
