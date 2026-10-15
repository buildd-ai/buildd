/**
 * Work a sweep could not finish because the kernel's host did not answer (a
 * `ControlPlaneUnavailableError`, retryable) is deferred to the next tick, not
 * settled as if it had been judged. A deferral is bounded: past
 * `DEFERRAL_MAX_TICKS` deferrals or `DEFERRAL_MAX_AGE_MS` since the first, the
 * sweep settles the row and records something a person sees, so an outage that
 * outlasts a day surfaces instead of retrying silently forever.
 *
 * Only an outage defers. A refusal (`KernelCommandRefusedError`) or the
 * command's own failure (`KernelCommandFailedError`) is deterministic: retrying
 * it every tick would never succeed, so those are settled as before.
 */
export const DEFERRAL_MAX_TICKS = 24;
export const DEFERRAL_MAX_AGE_MS = 24 * 60 * 60_000;

export interface DeferralState {
  /** ISO time of the first deferral in this run of them. */
  firstAt: string;
  /** Deferrals so far, this one included. */
  count: number;
  /** The last reason given. */
  reason: string;
}

/** The state after one more deferral, and whether it has now run out. */
export function nextDeferral(prev: DeferralState | null | undefined, reason: string, now: Date): { state: DeferralState; exhausted: boolean } {
  const firstAt = prev?.firstAt && !Number.isNaN(Date.parse(prev.firstAt)) ? prev.firstAt : now.toISOString();
  const count = (typeof prev?.count === 'number' && prev.count > 0 ? prev.count : 0) + 1;
  const state = { firstAt, count, reason };
  const exhausted = count >= DEFERRAL_MAX_TICKS || now.getTime() - Date.parse(firstAt) >= DEFERRAL_MAX_AGE_MS;
  return { state, exhausted };
}

/** A stored deferral, or null when the value is not one. */
export function deferralOf(v: unknown): DeferralState | null {
  if (!v || typeof v !== 'object') return null;
  const r = v as Record<string, unknown>;
  return typeof r.firstAt === 'string' && typeof r.count === 'number' ? { firstAt: r.firstAt, count: r.count, reason: typeof r.reason === 'string' ? r.reason : '' } : null;
}

/** A door answer body (kernel-client `doorErrorAnswer`) says the control plane did not answer: the only kind that defers. */
export function isOutageAnswer(body: Record<string, unknown> | null | undefined): boolean {
  return body?.code === 'control_plane_unavailable';
}
