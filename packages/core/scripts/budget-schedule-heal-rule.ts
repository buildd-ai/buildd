/**
 * Decision rules for `heal-budget-disabled-schedules.ts`.
 *
 * Kept dependency-free so they are unit-testable without a DB driver.
 */

/**
 * Is this schedule's disable consistent with the budget_exhausted ordering bug?
 *
 * The bug disables the schedule on the first cron tick at or after the mission
 * exhausted its budget, so `updatedAt` must be >= the exhaustion note. A
 * schedule disabled BEFORE the mission ever exhausted was disabled by something
 * else — most likely a human — and must never be re-enabled by the healer.
 *
 * Missing timestamps count as not-healable rather than assumed innocent: a
 * false negative costs someone re-enabling a schedule by hand, a false positive
 * resumes work that was deliberately stopped and spends money doing it.
 */
export function disableIsConsistentWithBudgetBug(
  scheduleUpdatedAt: Date | null | undefined,
  missionExhaustedAt: Date | null | undefined,
): boolean {
  if (!scheduleUpdatedAt || !missionExhaustedAt) return false;
  return scheduleUpdatedAt >= missionExhaustedAt;
}

/** Minutes between consecutive resumes. */
export const RESUME_STAGGER_MINUTES = 5;

/**
 * When the i-th healed schedule should next run.
 *
 * Every healed schedule is long overdue, so left alone they would all be due on
 * the same tick. The pacing and workspace-cap gates would absorb that, but
 * spreading the resumes keeps them legible in the cron logs and in the mission
 * feed. The first one is due immediately, so a heal is observable on the next
 * tick rather than in five minutes.
 */
export function staggeredResumeAt(now: Date, index: number): Date {
  return new Date(now.getTime() + index * RESUME_STAGGER_MINUTES * 60_000);
}
