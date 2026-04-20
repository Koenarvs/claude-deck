import { useNavigate } from 'react-router';
import { Plus, Link2, Kanban } from 'lucide-react';

export default function QuickActions() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-wrap gap-3">
      <button
        onClick={() => navigate('/board')}
        className="inline-flex items-center gap-2 rounded-lg border border-deck-accent bg-deck-accent/10 px-4 py-2 text-sm font-medium text-deck-accent-hover transition-colors hover:bg-deck-accent/20"
      >
        <Plus size={16} />
        New Goal
      </button>
      <button
        onClick={() => navigate('/settings')}
        className="inline-flex items-center gap-2 rounded-lg border border-deck-border bg-deck-surface px-4 py-2 text-sm font-medium text-deck-text transition-colors hover:bg-deck-border"
      >
        <Link2 size={16} />
        Install Hooks
      </button>
      <button
        onClick={() => navigate('/board')}
        className="inline-flex items-center gap-2 rounded-lg border border-deck-border bg-deck-surface px-4 py-2 text-sm font-medium text-deck-text transition-colors hover:bg-deck-border"
      >
        <Kanban size={16} />
        Open Board
      </button>
    </div>
  );
}
