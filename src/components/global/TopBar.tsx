/**
 * TopBar — shared page header.
 * Place at the top of each page component (above its scrollable body).
 */
import type { ReactNode } from 'react';

interface Tab {
  id: string;
  label: string;
  badge?: number;
}

interface TopBarProps {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  tabs?: Tab[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
}

export default function TopBar({
  title,
  subtitle,
  actions,
  tabs,
  activeTab,
  onTabChange,
}: TopBarProps) {
  return (
    <div className="flex flex-col border-b border-line bg-bg">
      <div className="flex items-center justify-between px-[22px] py-3.5">
        <div>
          <h1 className="m-0 text-[20px] font-semibold tracking-tight text-fg">
            {title}
          </h1>
          {subtitle && (
            <div className="mono-tabular mt-0.5 text-[12px] text-faint">
              {subtitle}
            </div>
          )}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>

      {tabs && tabs.length > 0 && (
        <div className="flex gap-[2px] px-[22px]">
          {tabs.map((t) => {
            const on = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => onTabChange?.(t.id)}
                className={`-mb-px border-b-2 px-3 py-2 text-[13px] transition-colors ${
                  on
                    ? 'border-accent font-medium text-fg'
                    : 'border-transparent font-normal text-dim hover:text-fg'
                }`}
              >
                {t.label}
                {t.badge != null && t.badge > 0 && (
                  <span className="mono-tabular ml-1.5 rounded-full bg-inset px-1.5 text-[10px] text-dim">
                    {t.badge}
                  </span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
