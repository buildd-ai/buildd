/**
 * The runner's half of the claim → session-start handoff.
 *
 * A claim response is the only place the runner learns a worker id. If the
 * request times out or the connection drops after the server has committed,
 * the server holds a worker row (idle, started_at NULL) that nobody will ever
 * start. This tracker lets every heartbeat say exactly what the runner holds:
 *
 *  - `pendingStartIds`: workers received in a claim response and not yet
 *    handed off to the worker map (prepare + start in progress).
 *  - `claimInFlight`: a claim request is outstanding, so rows it minted may
 *    exist server-side and must not be judged lost yet.
 *
 * The server releases any unstarted row minted for this runner that is in
 * neither list (apps/web/src/lib/lost-claim.ts). An id is added to the pending
 * set synchronously when the response is read, before the in-flight count is
 * released, so no heartbeat can observe a received worker in neither state.
 */
export interface ClaimHandoffSnapshot {
  pendingStartIds: string[];
  claimInFlight: boolean;
}

export class ClaimHandoffTracker {
  private inFlight = 0;
  private pending = new Set<string>();

  /** Run one claim request, recording the ids it returns as pending start. */
  async track<T extends { workers?: Array<{ id?: unknown }> }>(request: () => Promise<T>): Promise<T> {
    this.inFlight++;
    try {
      const result = await request();
      for (const w of result.workers ?? []) {
        if (typeof w?.id === 'string') this.pending.add(w.id);
      }
      return result;
    } finally {
      this.inFlight--;
    }
  }

  /** The worker reached the worker map, or its start failed and was reported. */
  settle(workerId: string): void {
    this.pending.delete(workerId);
  }

  snapshot(): ClaimHandoffSnapshot {
    return { pendingStartIds: [...this.pending], claimInFlight: this.inFlight > 0 };
  }
}
