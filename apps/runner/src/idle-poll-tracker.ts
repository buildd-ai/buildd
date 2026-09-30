/**
 * Low-volume trace of idle claim polls.
 *
 * A `no_pending_tasks` poll is the normal idle state, so it is not logged per
 * poll — but logging nothing made an idle runner indistinguishable from one
 * that had silently stopped polling. This counts idle polls and hands back a
 * summary on entering idle and then at most once per `summaryEveryMs`, and
 * keeps the last-poll time/outcome for /api/debug/internals.
 */

export type PollOutcome = 'no_pending_tasks' | 'claimed' | 'empty' | 'rejected';

export interface IdleSummary {
  /** Idle polls in the current streak, including this one. */
  idlePolls: number;
  /** When the current idle streak began (ms). */
  idleSince: number;
  /** Idle polls since the previous summary line (0 on the first). */
  pollsSinceLastSummary: number;
}

export interface IdlePollSnapshot {
  lastPollAt: number | null;
  lastPollOutcome: PollOutcome | null;
  idlePolls: number;
  idleSince: number | null;
}

export class IdlePollTracker {
  private lastPollAt: number | null = null;
  private lastPollOutcome: PollOutcome | null = null;
  private idlePolls = 0;
  private idleSince: number | null = null;
  private lastSummaryAt: number | null = null;
  private idlePollsAtLastSummary = 0;

  constructor(
    private readonly summaryEveryMs = 60 * 60_000,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record a poll that ended idle; returns a summary when one is due. */
  recordIdle(): IdleSummary | null {
    const t = this.now();
    this.lastPollAt = t;
    this.lastPollOutcome = 'no_pending_tasks';
    if (this.idleSince === null) this.idleSince = t;
    this.idlePolls++;
    const due = this.lastSummaryAt === null || t - this.lastSummaryAt >= this.summaryEveryMs;
    if (!due) return null;
    const summary: IdleSummary = {
      idlePolls: this.idlePolls,
      idleSince: this.idleSince,
      pollsSinceLastSummary: this.lastSummaryAt === null ? 0 : this.idlePolls - this.idlePollsAtLastSummary,
    };
    this.lastSummaryAt = t;
    this.idlePollsAtLastSummary = this.idlePolls;
    return summary;
  }

  /** Record any non-idle poll outcome; ends the idle streak. */
  recordPoll(outcome: Exclude<PollOutcome, 'no_pending_tasks'>): void {
    this.lastPollAt = this.now();
    this.lastPollOutcome = outcome;
    this.idlePolls = 0;
    this.idleSince = null;
    this.lastSummaryAt = null;
    this.idlePollsAtLastSummary = 0;
  }

  snapshot(): IdlePollSnapshot {
    return {
      lastPollAt: this.lastPollAt,
      lastPollOutcome: this.lastPollOutcome,
      idlePolls: this.idlePolls,
      idleSince: this.idleSince,
    };
  }
}
