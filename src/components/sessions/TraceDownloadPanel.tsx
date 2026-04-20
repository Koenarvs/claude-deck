import { Download, FileText, Package } from 'lucide-react';
import type { Session } from '../../shared/types';

interface TraceDownloadPanelProps {
  session: Session;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function TraceDownloadPanel({ session }: TraceDownloadPanelProps) {
  const baseUrl = `/api/sessions/${session.id}/trace`;

  return (
    <div className="rounded-lg border border-deck-border bg-deck-surface p-4">
      <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold text-deck-text">
        <Download size={16} />
        Trace Downloads
      </h3>

      <div className="flex flex-wrap gap-3">
        <TraceButton
          href={`${baseUrl}/stream`}
          icon={<FileText size={14} />}
          label="Stream Events"
          count={session.stream_event_count}
          sublabel="stream.jsonl"
        />

        <TraceButton
          href={`${baseUrl}/hooks`}
          icon={<FileText size={14} />}
          label="Hook Events"
          count={session.hook_event_count}
          sublabel="hooks.jsonl"
        />

        <TraceButton
          href={`${baseUrl}/bundle`}
          icon={<Package size={14} />}
          label="Full Bundle"
          sublabel="tar.gz"
        />
      </div>
    </div>
  );
}

// ── Sub-component ────────────────────────────────────────────────────────────

interface TraceButtonProps {
  href: string;
  icon: React.ReactNode;
  label: string;
  count?: number;
  sublabel: string;
}

function TraceButton({ href, icon, label, count, sublabel }: TraceButtonProps) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="flex items-center gap-3 rounded-md border border-deck-border px-4 py-2.5 text-sm text-deck-text transition-colors hover:border-deck-accent hover:bg-deck-accent/10"
    >
      <span className="text-deck-muted">{icon}</span>
      <div>
        <div className="flex items-center gap-2 font-medium">
          {label}
          {count != null && (
            <span className="rounded-full bg-deck-border px-1.5 py-0.5 text-xs tabular-nums text-deck-muted">
              {count}
            </span>
          )}
        </div>
        <div className="text-xs text-deck-muted">{sublabel}</div>
      </div>
    </a>
  );
}
