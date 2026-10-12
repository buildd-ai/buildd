/**
 * The weekly decision audit: a scheduled researcher task that grades a sample
 * of every decision feature's last week, so each feature's readout has an
 * accuracy measured by an agent rather than only fallback counts
 * (decision-feature-health.ts). Created in the buildd workspace with
 * create_schedule from these fields (an admin action); this file is the
 * source of the instructions, so changing them is a reviewed diff.
 *
 * The instructions name tools, not features: the auditor lists the features
 * that decided anything from the ledger (get_decision_stats capability "*"),
 * so a new decision kind is audited the week it ships.
 */

/** ISO 8601 week of a UTC date, e.g. `2026-W41`. */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday of this week decides the year.
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const year = t.getUTCFullYear();
  const week = Math.ceil(((t.getTime() - Date.UTC(year, 0, 1)) / 86_400_000 + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** The report artifact key for a run firing at `firedAt`: it grades the previous ISO week. */
export function decisionAuditArtifactKey(firedAt: Date): string {
  return `decision-audit-${isoWeek(new Date(firedAt.getTime() - 7 * 86_400_000))}`;
}

const INSTRUCTIONS = `Grade last week's decisions (the previous ISO week, Monday 00:00 to Monday 00:00 UTC) so each decision feature has a measured accuracy.

1. List the features: get_decision_stats { capability: "*", since, until } for the week. Each entry has a health readout. Skip features with 0 calls. A feature whose health.collection.state is not_collecting, misconfigured or disabled gets its sentence in the report and no sampling.
2. Sample up to 20 decisions per remaining feature: get_decision_stats { capability, since, until, limit: 500 }. Stratify: up to 7 acted (applied true), up to 7 recorded-only (status suggested), up to 6 fallback with a model answer (status fallback, verdict set). Fill a short stratum from the others. Spread picks across the week, not just the newest.
3. Judge each: get_decision { decisionId }. Decide from the subject's real evidence (the role the task ended with, what the work turned out to be, where its PR ended, the mission's outcome), asking what a careful engineer would have chosen with what was known then. Then label_decision { decisionId, label: right | wrong | unsure, rationale (at most 280 characters, cite the evidence), ruleLabel } where ruleLabel grades the rule's answer on the same decision (a null rule answer is the default behaviour: grade that). Use unsure when the evidence does not settle it; never guess. A conflict means it was already graded: leave it.
4. Re-read get_decision_stats { capability: "*", since, until } and write one report: create_artifact { type: "report", key: "decision-audit-<ISO week graded, e.g. 2026-W41>", title: "Decision audit <week>" }. Per feature: one verdict line (healthy, wrong too often, not deciding: <sentence>, or not enough evidence), calls, acted %, graded accuracy with n and its interval, the rule's accuracy on the same sample, override rate, and the worst examples by short decision id with one line each. Lead with the features that need a person.
5. If get_decision or label_decision returns FORBIDDEN, stop sampling and say in the report that this schedule needs an admin token. Never substitute another route.`;

export const DECISION_AUDIT_SCHEDULE = {
  name: 'Decision audit (weekly)',
  // Mondays 06:00 UTC: the week graded is complete.
  cronExpression: '0 6 * * 1',
  timezone: 'UTC',
  title: "[decision audit] grade last week's decisions",
  description: INSTRUCTIONS,
  roleSlug: 'researcher',
  tier: 'premium' as const,
} as const;
