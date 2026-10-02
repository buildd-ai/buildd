'use client';

/**
 * Optional runner targeting for a start: "Any available worker", or one live
 * local UI. Only the full task page mounts it (it polls runner health), so a
 * sheet or the mission drawer never pays for it.
 */
import { useState } from 'react';
import { useLocalUiHealth } from '@/app/app/(protected)/tasks/useLocalUiHealth';

const check = (
  <svg className="w-4 h-4 text-primary" fill="currentColor" viewBox="0 0 20 20">
    <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
  </svg>
);

export default function RunnerPicker({ workspaceId, value, onChange, disabled }: {
  workspaceId: string;
  value: string;
  onChange: (localUiUrl: string) => void;
  disabled?: boolean;
}) {
  const { available } = useLocalUiHealth(workspaceId);
  const [open, setOpen] = useState(false);
  if (available.length === 0) return null;
  const pick = (url: string) => { onChange(url); setOpen(false); };
  const option = (selected: boolean) =>
    `w-full text-left px-3 py-2.5 border transition-colors ${selected ? 'border-primary bg-primary-subtle' : 'border-border-default hover:border-text-muted'}`;
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        data-testid="runner-picker-toggle"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        className="min-h-11 self-start px-3 font-mono text-[12px] text-text-secondary hover:text-text-primary border border-border-default disabled:opacity-50"
      >
        {value ? available.find(ui => ui.localUiUrl === value)?.accountName ?? 'Worker' : 'Any available worker'}{' '}
        {open ? '▲' : '▾'}
      </button>
      {open && (
        <div className="max-w-md space-y-2 max-h-48 overflow-y-auto border border-border-default p-2">
          <button type="button" onClick={() => pick('')} disabled={disabled} className={option(value === '')}>
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium">Any available worker</span>
              {value === '' && check}
            </div>
            <p className="text-xs text-text-muted mt-0.5">Queued for the next available worker</p>
          </button>
          {available.map(ui => (
            <button key={ui.localUiUrl} type="button" onClick={() => pick(ui.localUiUrl)} disabled={disabled} className={option(value === ui.localUiUrl)}>
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{ui.accountName}</span>
                <div className="flex items-center gap-2">
                  {ui.live && (
                    <span className="flex items-center gap-1 text-xs text-status-success">
                      <span className="w-1.5 h-1.5 rounded-full bg-status-success" />
                      Live
                    </span>
                  )}
                  {value === ui.localUiUrl && check}
                </div>
              </div>
              <p className="text-xs text-text-muted mt-0.5">
                {ui.capacity} slot{ui.capacity !== 1 ? 's' : ''} available
              </p>
              {ui.environment && (
                <div className="mt-1.5 space-y-0.5">
                  {ui.environment.tools.length > 0 && (
                    <p className="text-[11px] text-text-muted truncate">
                      <span className="text-text-secondary">Tools:</span>{' '}
                      {ui.environment.tools.map(t => t.version ? `${t.name} ${t.version}` : t.name).join(', ')}
                    </p>
                  )}
                  {ui.environment.envKeys.length > 0 && (
                    <p className="text-[11px] text-text-muted truncate">
                      <span className="text-text-secondary">Env:</span>{' '}
                      {ui.environment.envKeys.length <= 3
                        ? ui.environment.envKeys.join(', ')
                        : `${ui.environment.envKeys.slice(0, 3).join(', ')} +${ui.environment.envKeys.length - 3} more`}
                    </p>
                  )}
                  {ui.environment.mcp.length > 0 && (
                    <p className="text-[11px] text-text-muted truncate">
                      <span className="text-text-secondary">MCP:</span>{' '}
                      {ui.environment.mcp.join(', ')}
                    </p>
                  )}
                </div>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
