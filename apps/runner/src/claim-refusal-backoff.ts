/**
 * Back off a broadcast assignment the server just refused (spec c7410e76,
 * task 9e12f377 part 4).
 *
 * The server re-broadcasts a pending task's assignment on every queue change.
 * Each one used to make the runner claim it again, and a task held by a gate
 * that had not moved (its files overlap an in-flight task, say) was refused
 * thousands of times in minutes. Now a refusal is remembered per task with its
 * reason; the same task's next assignment is skipped until either
 *   - something changed that can lift it: the task it waits for ended on this
 *     runner, any agent here ended (a cap or a slot may have freed), the
 *     runner's slots were raised or its hold lifted; or
 *   - the backoff ran out: 30s, doubling for each repeat of the same reason, up
 *     to 15 minutes. A different reason starts again at 30s.
 *
 * A person's own claim (`c` in top, a Start aimed at this runner) is never
 * skipped, and the broad poll is not affected: it asks the server for the
 * whole queue, which is how a lifted gate is found when no event says so.
 */
export interface RefusalEntry {
  /** The refusal's reason: the exclusion code (or diagnostic reason) and the task it waits for. */
  key: string;
  holderTaskId: string | null;
  at: number;
  until: number;
  streak: number;
}

export class ClaimRefusalBackoff {
  private entries = new Map<string, RefusalEntry>();
  private readonly baseMs: number;
  private readonly maxMs: number;
  private skipped = 0;

  constructor(opts: { baseMs?: number; maxMs?: number } = {}) {
    this.baseMs = opts.baseMs ?? 30_000;
    this.maxMs = opts.maxMs ?? 15 * 60_000;
  }

  /** The server refused this task's claim for `reason` (waiting on `holderTaskId`, when it named one). */
  refused(taskId: string, reason: string, holderTaskId: string | null, now: number): RefusalEntry {
    const key = `${reason}:${holderTaskId ?? ''}`;
    const prev = this.entries.get(taskId);
    const streak = prev && prev.key === key ? prev.streak + 1 : 1;
    const wait = Math.min(this.maxMs, this.baseMs * 2 ** (streak - 1));
    const entry: RefusalEntry = { key, holderTaskId, at: now, until: now + wait, streak };
    this.entries.set(taskId, entry);
    return entry;
  }

  /** Should a broadcast assignment of this task be skipped right now? */
  skip(taskId: string, now: number): RefusalEntry | null {
    const e = this.entries.get(taskId);
    if (!e) return null;
    if (now >= e.until) return null;
    this.skipped++;
    return e;
  }

  /** It was claimed (here or elsewhere), or it is gone: forget it. */
  clear(taskId: string): void {
    this.entries.delete(taskId);
  }

  /**
   * An agent on this runner ended. A task waiting for that agent's task can
   * start; so can one held by a cap or a free slot (no holder named).
   */
  agentEnded(taskId: string | null | undefined): void {
    for (const [id, e] of this.entries) {
      if (e.holderTaskId === null || (taskId && e.holderTaskId === taskId)) this.entries.delete(id);
    }
  }

  /** Slots raised or the hold lifted: every refusal may read differently now. */
  reset(): void {
    this.entries.clear();
  }

  /** How many assignments were skipped (for the log's summary line). */
  takeSkipped(): number {
    const n = this.skipped;
    this.skipped = 0;
    return n;
  }

  get size(): number {
    return this.entries.size;
  }
}
