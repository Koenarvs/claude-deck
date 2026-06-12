import type { OrchestratorStatus } from '../../shared/orchestrator';

const LABEL: Record<OrchestratorStatus, string> = {
  idle: 'Idle', waking: 'Waking…', active: 'Thinking…', cooling: 'Cooling down',
};
const TONE: Record<OrchestratorStatus, string> = {
  idle: 'text-deck-muted border-deck-border',
  waking: 'text-deck-accent border-deck-accent/40',
  active: 'text-deck-success border-deck-success/40',
  cooling: 'text-deck-muted border-deck-border',
};

export default function OrchestratorStatusPill({ status }: { status: OrchestratorStatus }) {
  return (
    <span
      className={`mono-tabular rounded-full border px-2.5 py-0.5 text-[11px] font-medium ${TONE[status]}`}
      data-testid="orchestrator-status"
    >
      {LABEL[status]}
    </span>
  );
}
