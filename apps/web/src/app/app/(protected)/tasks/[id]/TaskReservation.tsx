/**
 * Task page facts for a task filed through a client and held for one runner
 * account (docs/specs/claim-gate-legibility.md CG-7, docs/specs/acp-bridge.md).
 * Both read `tasks.context` only: `client` and `reservedBy`.
 */
import type { ReactElement } from 'react';
import { taskClientLabel } from '@/lib/task-client';
import { liveReservation, reservationRemainingLabel } from '@/lib/task-reservation';

function utcStamp(iso: string): string {
  const d = new Date(iso);
  const mon = d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' });
  const hh = String(d.getUTCHours()).padStart(2, '0');
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${d.getUTCDate()} ${mon}, ${hh}:${mm} UTC`;
}

export function TaskClientFrom({ context }: { context: unknown }): ReactElement | null {
  const label = taskClientLabel(context);
  if (!label) return null;
  return <span data-testid="task-client">{label}</span>;
}

/** Live only: nothing once it lapsed or the task was claimed. `holderName` is an account or runner name, never a key. */
export function TaskReservation({ context, status, holderName, now = new Date() }: {
  context: unknown;
  status: string;
  holderName: string | null;
  now?: Date;
}): ReactElement | null {
  const r = liveReservation(context, status, now);
  if (!r) return null;
  return (
    <span data-testid="task-reservation" className="[overflow-wrap:anywhere]">
      Reserved for {holderName ?? 'another account'} until {utcStamp(r.expiresAt)}
      <span className="text-text-muted"> · {reservationRemainingLabel(Date.parse(r.expiresAt) - now.getTime())}</span>
    </span>
  );
}
