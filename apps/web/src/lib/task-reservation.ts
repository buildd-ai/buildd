/**
 * Read side of a task's reservation (CG-7): who holds it and until when.
 * The write side is `buildReservation` in the claim route's held-gate; this file
 * only reads `context.reservedBy` and has no server imports so a page can use it.
 */
const RESERVATION_KEY = 'reservedBy';

export interface LiveReservation {
  accountId: string;
  expiresAt: string;
}

/** The reservation while it holds the task; null once lapsed, or once the task is claimed. */
export function liveReservation(context: unknown, status: string, now: Date = new Date()): LiveReservation | null {
  if (status !== 'pending') return null;
  if (!context || typeof context !== 'object') return null;
  const r = (context as Record<string, unknown>)[RESERVATION_KEY];
  if (!r || typeof r !== 'object') return null;
  const { accountId, expiresAt } = r as Record<string, unknown>;
  if (typeof accountId !== 'string' || !accountId || typeof expiresAt !== 'string') return null;
  const ms = Date.parse(expiresAt);
  if (!Number.isFinite(ms) || ms <= now.getTime()) return null;
  return { accountId, expiresAt };
}

/** "for 14 more min" from milliseconds left (rounded up). */
export function reservationRemainingLabel(msLeft: number): string {
  const mins = Math.ceil(msLeft / 60_000);
  return `for ${Math.max(1, mins)} more min`;
}
