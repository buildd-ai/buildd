/**
 * POST /api/cron/mission-invariants
 *
 * Hourly mission-state invariant sweep — the watchdog for the class of defect
 * that is invisible in task counts. Twelve named invariants, each one a shape
 * that actually shipped and then sat unnoticed because nothing in the system
 * could express it as a question: an integration-branch flag that reads on and
 * does nothing, a PR whose base branch was deleted out from under it, a plan
 * that produced no children, a mission nothing will ever verify.
 *
 * ── The check is code, the fix is an agent ──────────────────────────────────
 * A healthy fleet costs ONE set of queries per hour and spawns NOTHING — no
 * worker, no agent, no tokens. Nothing on this path asks a model anything. An
 * agent is dispatched only when an invariant is actually breached, and only for
 * the invariants staged to file. `lib/health-watcher.ts` is the precedent.
 *
 * ── Reporting is not gating ─────────────────────────────────────────────────
 * Same discipline as `/api/cron/queue-stall`, and for the same reason: this
 * route withholds nothing from anything. It names conditions. Ten of the twelve
 * ship report-only — the response body and the structured log are their whole
 * consumer. One, `orphaned_integration_base`, files a task, because it
 * is unambiguous, severe and self-evidently actionable, so it proves the whole
 * path (detect → dedupe → file → fix) end to end at near-zero noise. One,
 * `stale_criteria_escalation`, resolves itself directly through
 * `resolveCriteriaEscalation` — it names a write-side bug (an escalation clear
 * that should already have happened), not a human decision, so there is
 * nothing to file or notify about; a resolved count in the log is its whole
 * observability surface.
 *
 * Promoting another invariant to `files: true` or `resolves: true` is a later
 * diff, one invariant at a time, and the bar is: it has been OBSERVED to fire
 * on a real breach AND to stay quiet on a healthy fleet. A sweep that fires on
 * healthy transients gets muted within a week, and a muted sweep is worse than
 * none.
 *
 * ── Dedupe ─────────────────────────────────────────────────────────────────
 * The existing friction convention (see CLAUDE.md → Issues & Friction):
 * `context.frictionSignature` = invariant key + offending entity id, and a
 * `[friction] ` title. A persistent breach therefore accumulates on ONE task
 * instead of filing an hourly duplicate. The dedupe query is a local copy of
 * the one in `POST /api/tasks` rather than an HTTP call back into ourselves —
 * same predicate, no self-request from a cron function.
 *
 * ── Split ──────────────────────────────────────────────────────────────────
 * The invariant definitions and their evaluation are pure and live in
 * `lib/mission-invariants.ts`; the DB reads and the bounded GitHub calls live in
 * `lib/mission-invariant-scan.ts`. This route is the trigger, the transport and
 * the dedupe.
 *
 * Auth: Bearer CRON_SECRET.
 */

import { NextRequest, NextResponse } from 'next/server';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { and, eq, like, notInArray, sql } from 'drizzle-orm';
import { notify } from '@/lib/pushover';
import { withCronRun, type CronReport } from '@/lib/cron-run';
import { loadInvariantSnapshot } from '@/lib/mission-invariant-scan';
import {
  evaluateInvariants,
  formatInvariantReport,
  type InvariantResult,
  type InvariantSnapshot,
  type InvariantViolation,
} from '@/lib/mission-invariants';
import { resolveCriteriaEscalation, type CriteriaEscalationExitReason } from '@/lib/criteria-escalation';
import { systemActor } from '@/lib/mission-feed';

export const maxDuration = 60;

const APP_BASE_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'https://buildd.dev';

/** Task statuses that mean an existing friction report is still live. */
const CLOSED_TASK_STATUSES = ['completed', 'failed', 'cancelled'];

/** Lines in the Pushover digest before it collapses into "+N more". */
const DIGEST_LINES = 5;

/**
 * Ceiling on tasks filed in a single run. A filing invariant that suddenly
 * matches a hundred rows is a bug in the invariant, not a hundred incidents —
 * cap it and say what was dropped rather than paging in a loop.
 */
const MAX_FILINGS_PER_RUN = 5;

/**
 * The dedupe signature. Stable by construction: the invariant key never
 * changes, and the entity id is the row itself.
 */
export function invariantFrictionSignature(key: string, entityId: string): string {
  return `mission-invariant:${key}:${entityId}`;
}

type FilingOutcome = 'created' | 'appended' | 'skipped';

interface Filing {
  key: string;
  entityId: string;
  taskId: string | null;
  outcome: FilingOutcome;
}

async function fileViolation(
  result: InvariantResult,
  violation: InvariantViolation,
  now: Date,
): Promise<Filing> {
  const signature = invariantFrictionSignature(result.key, violation.entityId);
  const base: Filing = { key: result.key, entityId: violation.entityId, taskId: null, outcome: 'skipped' };

  // The error sentinel from a throwing predicate carries no workspace; there is
  // nothing to file it against.
  if (!violation.workspaceId) return base;

  const existing = await db.query.tasks.findFirst({
    where: and(
      eq(tasks.workspaceId, violation.workspaceId),
      like(tasks.title, '[friction] %'),
      sql`${tasks.context}->>'frictionSignature' = ${signature}`,
      notInArray(tasks.status, CLOSED_TASK_STATUSES),
    ),
    columns: { id: true },
  });

  if (existing) {
    const appendText = `\n\n---\n_Still breached at ${now.toISOString()}._\n${violation.detail}`;
    await db
      .update(tasks)
      .set({ description: sql`${tasks.description} || ${appendText}`, updatedAt: now })
      .where(eq(tasks.id, existing.id));
    return { ...base, taskId: existing.id, outcome: 'appended' };
  }

  const description = [
    `The hourly mission-invariant sweep found a breach of \`${result.key}\`.`,
    '',
    `**Invariant**: ${result.title}`,
    `**Offending ${violation.entityKind}**: ${violation.entityId}`,
    `**Evidence**: ${violation.detail}`,
    `**Breached for**: ~${Math.round(violation.ageMs / 3_600_000)}h`,
    '',
    `**Remedy**: ${result.remedy}`,
    '',
    'Detected by `POST /api/cron/mission-invariants` — the invariant definition lives in',
    '`apps/web/src/lib/mission-invariants.ts`. If this is a false positive, fix the predicate',
    'or its threshold there; do not silence the sweep.',
  ].join('\n');

  const inserted = await db
    .insert(tasks)
    .values({
      workspaceId: violation.workspaceId,
      title: `[friction] ${result.key}: ${violation.entityKind} ${violation.entityId}`.slice(0, 200),
      description,
      priority: 7,
      status: 'pending',
      mode: 'execution',
      taskClass: 'work',
      creationSource: 'webhook',
      category: 'bug',
      context: {
        frictionSignature: signature,
        frictionExcerpt: violation.detail,
        missionInvariantKey: result.key,
        missionInvariantEntityId: violation.entityId,
        missionInvariantEntityKind: violation.entityKind,
      },
    })
    .returning({ id: tasks.id });

  return { ...base, taskId: inserted?.[0]?.id ?? null, outcome: 'created' };
}

interface Reconciliation {
  entityId: string;
  cleared: boolean;
}

/**
 * Resolve one `stale_criteria_escalation` breach directly, via the single
 * writer. Not a filing — there is nothing for a human to act on here, only a
 * stranded flag that a write site should already have cleared.
 *
 * The reason threaded through is derived from the SAME snapshot the predicate
 * matched against, not re-queried: a terminal mission reads as
 * `'mission_completed'`, a passing verdict on a still-live mission reads as
 * `'verdict_changed'` — the goal-criteria consumer's own vocabulary for "the
 * thing the owner was asked about has moved."
 */
async function reconcileViolation(
  snapshot: InvariantSnapshot,
  violation: InvariantViolation,
): Promise<Reconciliation> {
  const m = snapshot.missions.find(mm => mm.id === violation.entityId);
  const reason: CriteriaEscalationExitReason =
    m && (m.status === 'completed' || m.status === 'archived') ? 'mission_completed' : 'verdict_changed';
  try {
    const outcome = await resolveCriteriaEscalation(
      violation.entityId,
      reason,
      systemActor('mission-invariant sweep: stale_criteria_escalation'),
    );
    return { entityId: violation.entityId, cleared: outcome.cleared };
  } catch (err) {
    console.error(`[mission-invariants] reconcile stale_criteria_escalation/${violation.entityId} failed:`, err);
    return { entityId: violation.entityId, cleared: false };
  }
}

export async function POST(req: NextRequest) {
  return withCronRun('mission-invariants', req, cronReport => runCronJob(cronReport));
}

async function runCronJob(cronReport: CronReport): Promise<NextResponse> {
  const now = new Date();
  const { snapshot, coverage } = await loadInvariantSnapshot(now);
  const results = evaluateInvariants(snapshot, now);
  const report = formatInvariantReport(results, { scanned: coverage });

  // ── File, for the invariants staged to file ───────────────────────────────
  const filings: Filing[] = [];
  let filingsDropped = 0;
  for (const result of results) {
    if (!result.files) continue;
    for (const violation of result.violations) {
      if (filings.length >= MAX_FILINGS_PER_RUN) {
        filingsDropped++;
        continue;
      }
      try {
        filings.push(await fileViolation(result, violation, now));
      } catch (err) {
        console.error(`[mission-invariants] filing ${result.key}/${violation.entityId} failed:`, err);
        filings.push({ key: result.key, entityId: violation.entityId, taskId: null, outcome: 'skipped' });
      }
    }
  }
  if (filingsDropped > 0) {
    console.warn(`[mission-invariants] ${filingsDropped} filing(s) dropped this run (cap ${MAX_FILINGS_PER_RUN})`);
  }

  // ── Resolve, for the invariant staged to resolve directly ──────────────────
  // Not a filing: `stale_criteria_escalation` names a stranded flag, not a
  // human decision, so a breach is cleared through the same single writer the
  // write sites use instead of being handed to anyone.
  const reconciliations: Reconciliation[] = [];
  for (const result of results) {
    if (!result.resolves) continue;
    for (const violation of result.violations) {
      reconciliations.push(await reconcileViolation(snapshot, violation));
    }
  }

  // ── Notify only on a NEW filing ───────────────────────────────────────────
  // A breach that is already on someone's queue does not page again; that is
  // the whole point of the dedupe signature.
  const created = filings.filter(f => f.outcome === 'created');
  if (created.length > 0) {
    const lines = created
      .slice(0, DIGEST_LINES)
      .map(f => `• ${f.key} — ${f.entityId}`);
    if (created.length > DIGEST_LINES) lines.push(`• +${created.length - DIGEST_LINES} more`);
    notify({
      app: 'alerts',
      title:
        created.length === 1
          ? `[buildd] Mission invariant breached — ${created[0].key}`
          : `[buildd] ${created.length} mission invariants breached`,
      message: lines.join('\n'),
      priority: 0,
      url: created.length === 1 && created[0].taskId
        ? `${APP_BASE_URL}/app/tasks/${created[0].taskId}`
        : `${APP_BASE_URL}/app/tasks`,
      urlTitle: created.length === 1 ? 'View task' : 'View tasks',
    });
  }

  const totals = results.map(r => ({
    key: r.key,
    count: r.violations.length,
    files: r.files,
    thresholdMs: r.thresholdMs,
  }));
  const violations = results.reduce((n, r) => n + r.violations.length, 0);

  const appendedCount = filings.filter(f => f.outcome === 'appended').length;
  const skippedCount = filings.filter(f => f.outcome === 'skipped').length;

  const resolvedCount = reconciliations.filter(r => r.cleared).length;

  console.log(
    JSON.stringify({
      event: 'mission_invariant_sweep',
      violations,
      scanned: coverage,
      filed: created.length,
      appended: appendedCount,
      resolved: resolvedCount,
      byInvariant: totals.filter(t => t.count > 0),
    }),
  );

  cronReport({
    processed: results.length,
    changed: created.length + appendedCount + resolvedCount,
    errors: skippedCount,
    result: { violations, filed: created.length, appended: appendedCount, dropped: filingsDropped, resolved: resolvedCount },
  });

  return NextResponse.json({
    ok: true,
    scanned: coverage,
    violations,
    invariants: totals,
    filed: created.length,
    appended: appendedCount,
    dropped: filingsDropped,
    resolved: resolvedCount,
    filings,
    reconciliations,
    report,
    // The offending ids per invariant, so an agent consuming this response does
    // not have to parse the human-readable report to act on it.
    detail: results
      .filter(r => r.violations.length > 0)
      .map(r => ({ key: r.key, remedy: r.remedy, violations: r.violations })),
  });
}
