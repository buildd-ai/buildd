/**
 * Recovery attempt events (operator-recovery spec §4.2, §10.5; FIR §8 audit row).
 *
 * Every repair the recovery loop runs writes one `gate_events` row, gate
 * `incident_recovery`, with a fixed `detail` shape so telemetry counts attempts
 * without parsing text:
 *
 *   { actionKey, incidentId, causeKey, capability, generation, attempt, subject,
 *     actor, verify: { predicate, passed, evidenceRevision }, costUsd }
 *
 * `verify.passed` is null when the repair runs; the next assessment that
 * re-checks it fills it in, in place, on that same row: one row per action
 * key, ever. `capability` holds RepairKind names only (§9.2).
 *
 * Also here: the 180-day prune for this gate (no other gate is pruned), and the
 * sweep's last run in `system_cache` (`failure-sentinel-last-run`), which the
 * operator read model uses for telemetry lag and completeness.
 */
import type { FailureIncidentRecovery, FailureRecoveryRef } from '@buildd/shared';
import type { RecoveryRepairAction, RecoverySource } from './failure-incident-recovery';

/** operator-recovery §9.2. Closed set; nothing outside it is ever written to `detail.capability`. */
export type RepairKind =
  | 'release_blocker'
  | 'wake_subject'
  | 'redeliver_dispatch'
  | 'retry_stale_worker'
  | 'rerun_visual_audit'
  | 'kernel_ci_retry'
  | 'queue_fix';

export const REPAIR_KINDS: readonly RepairKind[] = [
  'release_blocker', 'wake_subject', 'redeliver_dispatch', 'retry_stale_worker', 'rerun_visual_audit', 'kernel_ci_retry', 'queue_fix',
];

/** FIR's repair actions under their RepairKind names. */
export function repairKindOf(action: RecoveryRepairAction): RepairKind {
  if (action === 'file_fix_task') return 'queue_fix';
  // Releasing a credential hold wakes the held task (§18.4).
  if (action === 'release_hold') return 'wake_subject';
  // Re-queueing blocked audits for a fresh capture (§16.3).
  if (action === 'retry_capture') return 'rerun_visual_audit';
  return action;
}

export const RECOVERY_EVENT_SURFACE = 'failure-incident-recovery';
export const RECOVERY_EVENT_RETENTION_DAYS = 180;
export const SENTINEL_LAST_RUN_KEY = 'failure-sentinel-last-run';

export interface RecoveryAttemptDetail {
  actionKey: string;
  incidentId: string;
  causeKey: string | null;
  capability: RepairKind;
  generation: number;
  attempt: number;
  subject: FailureRecoveryRef;
  /** `buildd:<source>` for the loop; `platform_admin:<accountId>` / `team:<accountId>` for clicks (B2). */
  actor: string;
  verify: { predicate: string; passed: boolean | null; evidenceRevision: string };
  costUsd: number | null;
  /** A repair run once for a shared cause (§9.1): every member incident and subject it covers. */
  members?: { incidentIds: string[]; subjects: FailureRecoveryRef[] };
  /** The approved runbook that chose it, when one did (§9.3). */
  runbook?: string;
}

export interface RecoveryAttemptEvent {
  workspaceId: string | null;
  /**
   * `accepted`: the writer ran; `rejected`: it threw (a failed attempt, never
   * retried silently); `deferred`: a policy in shadow recorded what it would
   * have run and ran nothing (§9.5; the gate vocabulary has no `shadow`).
   */
  outcome: 'accepted' | 'rejected' | 'deferred';
  detail: RecoveryAttemptDetail;
}

/** Where attempt rows go. A port so the loop stays testable without a database. */
export interface RecoveryEventsPort {
  attempt(event: RecoveryAttemptEvent): Promise<void>;
  verify(actionKey: string, verify: { predicate: string; passed: boolean; evidenceRevision: string }): Promise<void>;
}

/** `...:a<n>` → n. */
export function attemptNumberOf(actionKey: string): number {
  const m = /:a(\d+)$/.exec(actionKey);
  return m ? Number(m[1]) : 0;
}

export function buildAttemptEvent(input: {
  incident: { id: string; workspaceId: string | null };
  recovery: FailureIncidentRecovery;
  repair: { key: string; action: RecoveryRepairAction; subject: FailureRecoveryRef };
  source: RecoverySource;
  ok: boolean;
}): RecoveryAttemptEvent {
  const { recovery, repair } = input;
  return {
    workspaceId: input.incident.workspaceId,
    outcome: input.ok ? 'accepted' : 'rejected',
    detail: {
      actionKey: repair.key,
      incidentId: input.incident.id,
      causeKey: recovery.causeGroup?.key ?? null,
      capability: repairKindOf(repair.action),
      generation: recovery.generation,
      attempt: attemptNumberOf(repair.key),
      subject: repair.subject,
      actor: `buildd:${input.source}`,
      verify: { predicate: recovery.verification.predicate, passed: null, evidenceRevision: recovery.observation.evidenceRevision },
      costUsd: null,
    },
  };
}

/**
 * Pure. The verify result for the repair the prior assessment ran, once the
 * next assessment has re-checked it. Null while it is still in flight, when the
 * re-check could not read the facts (unknown is never a verdict), or when the
 * prior assessment ran nothing. Passing needs the family's check or real
 * progress after the attempt (§9.4); the writer returning is not success.
 */
export function verifyPriorAttempt(
  prior: FailureIncidentRecovery | null,
  next: FailureIncidentRecovery,
): { actionKey: string; passed: boolean; predicate: string; evidenceRevision: string } | null {
  if (!prior || prior.state !== 'recovering' || !prior.nextAction) return null;
  const key = prior.nextAction.key;
  if (!prior.budget.spentKeys.includes(key)) return null;
  const attempt = prior.attempts.find(a => a.key === key);
  if (!attempt) return null;
  if (next.state === 'recovering' && next.nextAction?.key === key) return null;
  if (next.state === 'inconclusive' || next.state === 'observing') return null;
  const passed = next.state === 'recovered' || (!!next.lastProgressAt && next.lastProgressAt > attempt.at);
  return { actionKey: key, passed, predicate: next.verification.predicate, evidenceRevision: next.observation.evidenceRevision };
}

// ── DB-backed ───────────────────────────────────────────────────────────────

/** The production port: `recordGateEvent` for the row, an in-place jsonb update for verify. Never throws. */
export function dbRecoveryEvents(): RecoveryEventsPort {
  return {
    async attempt(event) {
      const { recordGateEvent, GATE_SLUGS } = await import('@buildd/core/gate-events');
      await recordGateEvent({
        gate: GATE_SLUGS.INCIDENT_RECOVERY,
        surface: RECOVERY_EVENT_SURFACE,
        outcome: event.outcome,
        reason: `recovery ${event.detail.capability}`,
        workspaceId: event.workspaceId,
        taskId: event.detail.subject.kind === 'task' ? event.detail.subject.id : null,
        detail: event.detail as unknown as Record<string, unknown>,
        callerOrigin: 'system',
      });
    },
    async verify(actionKey, verify) {
      try {
        const [{ db }, { gateEvents }, { and, eq, sql }, { GATE_SLUGS }] = await Promise.all([
          import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('@buildd/core/gate-events'),
        ]);
        await db
          .update(gateEvents)
          .set({ detail: sql`jsonb_set(${gateEvents.detail}, '{verify}', ${JSON.stringify(verify)}::jsonb)` })
          .where(and(
            eq(gateEvents.gate, GATE_SLUGS.INCIDENT_RECOVERY),
            sql`${gateEvents.detail}->>'actionKey' = ${actionKey}`,
            // First verdict wins: a re-check never rewrites a recorded result.
            sql`${gateEvents.detail}->'verify'->'passed' = 'null'::jsonb`,
          ));
      } catch (err) {
        console.error(`[failure-incident-recovery] verify record failed for ${actionKey}:`, err);
      }
    },
  };
}

/** Delete `incident_recovery` rows older than the retention. Only that gate. Returns rows removed. */
export async function pruneRecoveryEvents(now: Date = new Date()): Promise<number> {
  const [{ db }, { gateEvents }, { and, eq, lt }, { GATE_SLUGS }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'), import('@buildd/core/gate-events'),
  ]);
  const cutoff = new Date(now.getTime() - RECOVERY_EVENT_RETENTION_DAYS * 86_400_000);
  const rows = await db
    .delete(gateEvents)
    .where(and(eq(gateEvents.gate, GATE_SLUGS.INCIDENT_RECOVERY), lt(gateEvents.occurredAt, cutoff)))
    .returning({ id: gateEvents.id });
  return rows.length;
}

export interface SentinelLastRun {
  startedAt: string;
  finishedAt: string;
  /** True for a sweep over every workspace (the cron backstop), false for a triggered one. */
  full: boolean;
  workspaces: number;
  runFailures: number;
  incidentsAssessed: number;
  recoveryRepairs: number;
}

export async function writeSentinelLastRun(run: SentinelLastRun): Promise<void> {
  const [{ db }, { systemCache }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema')]);
  await db
    .insert(systemCache)
    .values({ key: SENTINEL_LAST_RUN_KEY, value: run, updatedAt: new Date() })
    .onConflictDoUpdate({ target: systemCache.key, set: { value: run, updatedAt: new Date() } });
}

/** The stored last run, or null when never written or unreadable as one. */
export function readSentinelLastRun(value: unknown): SentinelLastRun | null {
  const v = value as Partial<SentinelLastRun> | null;
  return v && typeof v.finishedAt === 'string' && typeof v.startedAt === 'string' ? (v as SentinelLastRun) : null;
}
