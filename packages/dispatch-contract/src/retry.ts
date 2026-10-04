// Delivery backoff, shared by the in-app drain and the Dispatch transport so a
// workspace's retry cadence does not change when it moves between them.
// packages/core/dispatch-outbox.ts re-exports these; a parity test pins it.

export const MAX_DELIVERY_ATTEMPTS = 8;

/** Delay before the next attempt, given the attempts made so far: 15 s doubling, capped at 30 min. */
export function retryDelayMs(attemptCount: number): number {
  return Math.min(15_000 * 2 ** Math.max(0, attemptCount - 1), 30 * 60_000);
}
