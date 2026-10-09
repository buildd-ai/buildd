import type { ReactNode } from 'react';
import { TonePill } from '@/components/ui/StatePill';

/**
 * One alert channel on Settings › Notifications as an L1 row: sans title, the
 * shared Connected / Not connected pill, a muted sub line, the row's buttons
 * on the right and, while editing, its form underneath. The list owns the
 * hairlines (`divide-y`), so a row never draws a frame of its own.
 */
export default function ChannelRow({
  title, connected, sub, actions, children, testId, pillTestId,
}: {
  title: string;
  connected: boolean;
  sub?: ReactNode;
  actions?: ReactNode;
  /** The inline form, shown under the row while editing. */
  children?: ReactNode;
  testId?: string;
  pillTestId?: string;
}) {
  return (
    <li className="py-3" data-testid={testId}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-text-primary">{title}</span>
            <span data-testid={pillTestId}>
              <TonePill tone={connected ? 'ok' : 'q'}>{connected ? 'Connected' : 'Not connected'}</TonePill>
            </span>
          </div>
          {sub && <div className="mt-0.5 text-xs text-text-secondary">{sub}</div>}
        </div>
        {actions && <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children && <div className="mt-3 space-y-2">{children}</div>}
    </li>
  );
}
