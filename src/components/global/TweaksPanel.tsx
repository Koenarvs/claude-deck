import { X } from 'lucide-react';
import { useUIConfigStore } from '../../stores/useUIConfigStore';
import type {
  Aesthetic,
  Theme,
  BoardLayout,
  LiveActivity,
} from '../../stores/useUIConfigStore';

export default function TweaksPanel() {
  const {
    aesthetic,
    theme,
    boardLayout,
    liveActivity,
    setAesthetic,
    setTheme,
    setBoardLayout,
    setLiveActivity,
    setTweaksOpen,
  } = useUIConfigStore();

  return (
    <div
      role="dialog"
      aria-label="Tweaks"
      className="fixed bottom-5 right-5 z-40 w-[280px] rounded-md border border-line-strong bg-card p-4 shadow-xl"
    >
      <div className="mb-3.5 flex items-center justify-between">
        <div className="text-[13px] font-semibold">Tweaks</div>
        <button
          type="button"
          onClick={() => setTweaksOpen(false)}
          className="text-dim transition-colors hover:text-fg"
          aria-label="Close tweaks"
        >
          <X size={14} />
        </button>
      </div>

      <div className="flex flex-col gap-3.5">
        <Row
          label="Aesthetic"
          hint={hintFor(aesthetic)}
          value={aesthetic}
          options={[
            { label: 'Studio', value: 'studio' },
            { label: 'Console', value: 'console' },
            { label: 'Mission', value: 'mission' },
          ]}
          onChange={(v) => setAesthetic(v as Aesthetic)}
        />
        <Row
          label="Theme"
          value={theme}
          options={[
            { label: 'Dark', value: 'dark' },
            { label: 'Light', value: 'light' },
          ]}
          onChange={(v) => setTheme(v as Theme)}
        />
        <Row
          label="Board layout"
          value={boardLayout}
          options={[
            { label: 'Columns', value: 'columns' },
            { label: 'Compact', value: 'compact' },
            { label: 'Table', value: 'table' },
          ]}
          onChange={(v) => setBoardLayout(v as BoardLayout)}
        />
        <Row
          label="Live activity"
          value={liveActivity}
          options={[
            { label: 'On', value: 'on' },
            { label: 'Subtle', value: 'subtle' },
            { label: 'Off', value: 'off' },
          ]}
          onChange={(v) => setLiveActivity(v as LiveActivity)}
        />
      </div>
    </div>
  );
}

function hintFor(a: Aesthetic) {
  if (a === 'studio') return 'Modern SaaS — clean, roomy, rounded.';
  if (a === 'console') return 'Terminal — monospace, dense, hairlines.';
  return 'Observability — data-dense, signal colors.';
}

interface Option {
  label: string;
  value: string;
}
interface RowProps {
  label: string;
  hint?: string;
  value: string;
  options: Option[];
  onChange: (v: string) => void;
}

function Row({ label, hint, value, options, onChange }: RowProps) {
  return (
    <div>
      <div className="mono-tabular mb-1.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-faint">
        {label}
      </div>
      <Segmented value={value} options={options} onChange={onChange} />
      {hint && (
        <div className="mt-1.5 text-[11px] leading-[1.4] text-faint">{hint}</div>
      )}
    </div>
  );
}

function Segmented({ value, options, onChange }: Pick<RowProps, 'value' | 'options' | 'onChange'>) {
  return (
    <div className="inline-flex gap-[2px] rounded-md border border-line bg-inset p-[2px]">
      {options.map((o) => {
        const on = value === o.value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={`rounded-[4px] px-2.5 py-1 text-[12px] transition-colors ${
              on
                ? 'border border-line bg-card font-medium text-fg'
                : 'border border-transparent bg-transparent text-dim hover:text-fg'
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}
