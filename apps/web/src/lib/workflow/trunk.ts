/**
 * The trunk circuit breaker (docs/specs/workflow-state-kernel.md §5.8, §6.10,
 * T25/T26, S24, AC-15).
 *
 * A CI failure is classified by its signature: the normalised names of the
 * check runs that failed on the head, at test level where the job log names
 * its failing tests (a sharded job's name is shared by unrelated failures). When the PR's base branch fails the same
 * checks on its own head (on by default), or, opted in, enough deliveries hit
 * the same signature inside a window, the failure is the trunk's, not the
 * PR's: the delivery joins one `trunk_incidents` row and goes
 * BLOCKED_ON_TRUNK (T25) instead of filing a per-PR CI attempt. One trunk-fix
 * task exists per red base (`dispatch_trunk_fix`, the package's
 * handlers/trunk.ts, reading this ledger through `builddTrunk`). The
 * recovery sweep re-reads each open incident's base head; once the base no
 * longer fails the incident's checks the incident resolves and every blocked
 * delivery re-enters its resume state (T26), with a mechanical branch refresh
 * when its head predates the fix. The `ci` budget is never spent meanwhile.
 *
 * Incident rows are opened and joined by one upsert on the open-signature
 * unique index; no interactive transaction (neon-http).
 */
import { sql, type SQL } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import type { CheckRunsRead, Trunk, TrunkIncident } from '@buildd/workflow-kernel/ports';
import type { Exec } from './kernel';
import type { GithubFactReader } from './facts';
import { UNKNOWN_CI_SIGNATURE, ciSignature, signatureCheckNames, trunkExplains, trunkRecovered } from './trunk-signature';
import { scheduleTrunkRecheck } from './trunk-recheck';

export { UNKNOWN_CI_SIGNATURE, ciSignature, signatureCheckNames, signatureChecks, trunkExplains, trunkRecovered } from './trunk-signature';

const dbExec: Exec = (q) => db.execute(q) as unknown as Promise<{ rows?: unknown[] }>;

export const DEFAULT_TRUNK_WINDOW_MINUTES = 60;
/** Bound on the incident's affected-delivery list (§5.8). */
export const TRUNK_AFFECTED_CAP = 200;

// ── Policy ──────────────────────────────────────────────────────────────────

export interface TrunkBreakerConfig {
  /** The breaker as a whole; `gitConfig.trunkBreaker = false` turns it off. */
  enabled: boolean;
  /** Multi-delivery rule (opt-in): this many distinct deliveries on one signature inside the window. */
  minDeliveries: number | null;
  windowMinutes: number;
}

/**
 * Absent = on with the base-red rule only (spec open question 7: base-red
 * alone opens the incident). The multi-delivery rule needs
 * `trunkBreaker: { minDeliveries, windowMinutes? }`.
 */
export function trunkBreakerConfig(gitConfig: unknown): TrunkBreakerConfig {
  const v = (gitConfig as { trunkBreaker?: unknown } | null | undefined)?.trunkBreaker;
  if (v === false || v === 'off') return { enabled: false, minDeliveries: null, windowMinutes: DEFAULT_TRUNK_WINDOW_MINUTES };
  const o = v && typeof v === 'object' ? (v as { minDeliveries?: unknown; windowMinutes?: unknown }) : {};
  const min = typeof o.minDeliveries === 'number' && o.minDeliveries >= 2 ? Math.floor(o.minDeliveries) : null;
  const win = typeof o.windowMinutes === 'number' && o.windowMinutes > 0 ? o.windowMinutes : DEFAULT_TRUNK_WINDOW_MINUTES;
  return { enabled: true, minDeliveries: min, windowMinutes: win };
}

// ── SQL ─────────────────────────────────────────────────────────────────────

export function openOrJoinIncidentSql(p: { workspaceId: string; repoFullName: string; baseRef: string; signature: string; deliveryId: string }): SQL {
  return sql`-- workflow:trunk_open_or_join
INSERT INTO trunk_incidents (workspace_id, repo_full_name, base_ref, signature, affected_deliveries)
VALUES (${p.workspaceId}::uuid, ${p.repoFullName}::text, ${p.baseRef}::text, ${p.signature}::text, jsonb_build_array(${p.deliveryId}::text))
ON CONFLICT (workspace_id, repo_full_name, base_ref, signature) WHERE status <> 'resolved'
DO UPDATE SET
  affected_deliveries = CASE
    WHEN trunk_incidents.affected_deliveries ? ${p.deliveryId}::text
      OR jsonb_array_length(trunk_incidents.affected_deliveries) >= ${TRUNK_AFFECTED_CAP}::int
    THEN trunk_incidents.affected_deliveries
    ELSE trunk_incidents.affected_deliveries || jsonb_build_array(${p.deliveryId}::text) END,
  updated_at = now()
RETURNING id, (xmax = 0) AS opened`;
}

export function openIncidentsForBaseSql(workspaceId: string, repoFullName: string, baseRef: string): SQL {
  return sql`-- workflow:trunk_open_for_base
SELECT id, signature FROM trunk_incidents
WHERE workspace_id = ${workspaceId}::uuid AND repo_full_name = ${repoFullName}::text AND base_ref = ${baseRef}::text AND status <> 'resolved'
ORDER BY first_seen_at`;
}

/** Distinct other deliveries of this repo whose CI attempt hit `signature` inside the window. */
export function recentSignatureDeliveriesSql(p: { workspaceId: string; repoFullName: string; signature: string; windowMinutes: number; excludeDeliveryId: string }): SQL {
  return sql`-- workflow:trunk_recent_signature
SELECT count(DISTINCT wa.delivery_id)::int AS n
FROM workflow_attempts wa JOIN workflow_deliveries d ON d.id = wa.delivery_id
WHERE d.workspace_id = ${p.workspaceId}::uuid AND d.repo_full_name = ${p.repoFullName}::text AND d.authority = 'kernel'
  AND wa.family = 'ci' AND wa.trigger_reason = ${p.signature}::text
  AND wa.created_at > now() - make_interval(mins => ${p.windowMinutes}::int)
  AND wa.delivery_id <> ${p.excludeDeliveryId}::uuid`;
}

/** Kernel deliveries on the same base that are repairing CI with an open attempt (candidates to join a new incident). */
export function repairingCiOnBaseSql(p: { workspaceId: string; repoFullName: string; baseRef: string; excludeDeliveryId: string }): SQL {
  return sql`-- workflow:trunk_repairing_on_base
SELECT d.id, d.current_head_sha, wa.trigger_reason
FROM workflow_deliveries d JOIN workflow_attempts wa ON wa.id = d.bound_attempt_id
WHERE d.workspace_id = ${p.workspaceId}::uuid AND d.repo_full_name = ${p.repoFullName}::text AND d.base_ref = ${p.baseRef}::text
  AND d.authority = 'kernel' AND d.state = 'REPAIRING' AND d.state_reason = 'ci'
  AND wa.family = 'ci' AND wa.status IN ('queued', 'running')
  AND d.id <> ${p.excludeDeliveryId}::uuid
LIMIT ${TRUNK_AFFECTED_CAP}::int`;
}

/** The least recently rechecked first: every recheck that leaves one unresolved touches it (`touchIncidentSql`). */
export function unresolvedIncidentsSql(limit: number): SQL {
  return sql`-- workflow:trunk_unresolved
SELECT id, workspace_id, repo_full_name, base_ref, signature, trunk_fix_task_id FROM trunk_incidents
WHERE status <> 'resolved' ORDER BY updated_at, id LIMIT ${limit}::int`;
}

/** The named incidents, still unresolved (the recheck queue's members, trunk-recheck.ts). */
export function unresolvedIncidentsByIdSql(ids: readonly string[]): SQL {
  const list = sql.join(ids.map((id) => sql`${id}::uuid`), sql`, `);
  return sql`-- workflow:trunk_unresolved_by_id
SELECT id, workspace_id, repo_full_name, base_ref, signature, trunk_fix_task_id FROM trunk_incidents
WHERE id IN (${list}) AND status <> 'resolved'`;
}

/**
 * An incident rechecked and left unresolved goes to the back of the sweep's
 * queue. Without it the same oldest page (a base still red, a workspace with
 * no repo) is all the sweep ever reads, and a newer incident whose base is
 * green is never resolved.
 */
export function touchIncidentSql(id: string): SQL {
  return sql`-- workflow:trunk_touch
UPDATE trunk_incidents SET updated_at = now() WHERE id = ${id}::uuid AND status <> 'resolved'`;
}

export function resolveIncidentSql(id: string): SQL {
  return sql`-- workflow:trunk_resolve
UPDATE trunk_incidents SET status = 'resolved', resolved_at = now(), updated_at = now()
WHERE id = ${id}::uuid AND status <> 'resolved'
RETURNING id`;
}

/**
 * Deliveries still blocked on an incident that has resolved (this pass or an earlier, interrupted one),
 * or only on the named incidents (a recheck of a few).
 */
export function blockedOnResolvedSql(limit: number, incidentIds?: readonly string[]): SQL {
  const only = incidentIds ? sql`AND i.id IN (${sql.join(incidentIds.map((id) => sql`${id}::uuid`), sql`, `)})` : sql``;
  return sql`-- workflow:trunk_blocked_on_resolved
SELECT d.id, d.workspace_id, d.repo_full_name, d.current_head_sha, d.trunk_incident_id, i.base_ref
FROM workflow_deliveries d JOIN trunk_incidents i ON i.id = d.trunk_incident_id
WHERE d.state = 'BLOCKED_ON_TRUNK' AND d.authority = 'kernel' AND i.status = 'resolved' ${only}
LIMIT ${limit}::int`;
}

// ── The incident ledger as the kernel's `Trunk` port ───────────────────────

export function trunkIncidentSql(id: string): SQL {
  return sql`-- workflow:trunk_incident
SELECT id, workspace_id, repo_full_name, base_ref, signature, status, trunk_fix_task_id, affected_deliveries FROM trunk_incidents WHERE id = ${id}::uuid`;
}

/**
 * The trunk-fix task this incident belongs to: the oldest unresolved incident on
 * the same base whose fix is not finished (no task yet, or a task still open),
 * falling back to the incident itself. Its linked task when it has one, else its
 * own id, which is the id its own dispatch files under. One statement, no
 * interactive transaction (neon-http): every incident of one red base resolves
 * to the same id, and the task insert's primary key makes it one row.
 */
export function trunkFixAnchorSql(incidentId: string): SQL {
  const terminal = sql.join(TERMINAL_TASK_STATUSES.map((s) => sql`${s}::text`), sql`, `);
  return sql`-- workflow:trunk_fix_anchor
SELECT COALESCE(o.trunk_fix_task_id, o.id) AS task_id, o.id AS incident_id, t.context->>'signature' AS fix_signature
FROM trunk_incidents me
JOIN trunk_incidents o ON o.workspace_id = me.workspace_id AND o.repo_full_name = me.repo_full_name AND o.base_ref = me.base_ref
  AND o.status <> 'resolved'
LEFT JOIN tasks t ON t.id = o.trunk_fix_task_id
WHERE me.id = ${incidentId}::uuid
  AND (o.id = me.id OR (o.trunk_fix_task_id IS NULL AND (o.first_seen_at, o.id) < (me.first_seen_at, me.id)) OR t.status NOT IN (${terminal}))
ORDER BY (o.first_seen_at, o.id)
LIMIT 1`;
}

/** The incident's fix task, only while it has none, is unresolved, and the task exists (the FK, §13.1 deviation 9). */
export function linkTrunkFixSql(incidentId: string, taskId: string): SQL {
  return sql`-- workflow:trunk_link_fix
UPDATE trunk_incidents SET trunk_fix_task_id = ${taskId}::uuid, status = 'fixing', updated_at = now()
WHERE id = ${incidentId}::uuid AND trunk_fix_task_id IS NULL AND status <> 'resolved'
  AND EXISTS (SELECT 1 FROM tasks WHERE id = ${taskId}::uuid)`;
}

/**
 * T26's reading of the base head: none of the incident's entries fails on it,
 * and the incident's checks have finished there. Every run finished is enough;
 * so is a whole list of what is still going that names none of the incident's
 * checks (a busy base rarely has a head with nothing running). Unknown is never
 * recovered.
 */
export function trunkRecoveredOnRuns(incidentSignature: string, runs: CheckRunsRead | null): boolean {
  if (!runs || !trunkRecovered(incidentSignature, runs.tests ?? runs.failing)) return false;
  if (runs.complete) return true;
  if (!runs.pending) return false;
  const checks = new Set(signatureCheckNames(incidentSignature));
  return !signatureCheckNames(ciSignature(runs.pending)).some((c) => checks.has(c));
}

/**
 * T26's evidence for a base with no CI of its own. A mission branch's pushes run no gating workflow,
 * so its head has no check runs and `trunkRecoveredOnRuns` reads it as unknown at every recheck,
 * until something else moves the base. There the fix stands in for the base's own run: the
 * incident's fix PR merged into this base, its own checks (run on its merge ref) finished with none
 * of the incident's entries failing, and the base head contains its merge commit. Only when the
 * base head reads no runs at all; a base that reports runs is read by them alone.
 */
export async function trunkFixLandedGreen(p: {
  repoFullName: string; baseRef: string; baseHead: string; signature: string; fixPrNumber: number | null; reader: GithubFactReader;
}): Promise<boolean> {
  if (p.fixPrNumber == null || !p.reader.checkRuns || !p.reader.contains) return false;
  const pr = await p.reader.readPr(p.repoFullName, p.fixPrNumber).catch(() => null);
  if (!pr?.merged || !pr.mergeCommitSha || pr.baseRef !== p.baseRef) return false;
  const runs = await p.reader.checkRuns(p.repoFullName, pr.headSha, { tests: true }).catch(() => null);
  if (!runs?.complete || !trunkRecoveredOnRuns(p.signature, runs)) return false;
  return p.reader.contains(p.repoFullName, pr.mergeCommitSha, p.baseHead).catch(() => false);
}

/** buildd's `trunk_incidents` as the kernel's `Trunk` port. */
export function builddTrunk(exec: Exec = dbExec): Trunk {
  return {
    async incident(id) {
      const r = ((await exec(trunkIncidentSql(id))).rows ?? [])[0] as Record<string, unknown> | undefined;
      if (!r) return null;
      const inc: TrunkIncident = {
        id: String(r.id), workspaceId: String(r.workspace_id), repoFullName: String(r.repo_full_name), baseRef: String(r.base_ref),
        signature: String(r.signature), status: String(r.status), fixTaskId: r.trunk_fix_task_id == null ? null : String(r.trunk_fix_task_id),
        affectedDeliveries: Array.isArray(r.affected_deliveries) ? r.affected_deliveries.map(String) : [],
      };
      return inc;
    },
    async fixAnchor(incidentId) {
      const r = ((await exec(trunkFixAnchorSql(incidentId))).rows ?? [])[0] as { task_id?: string; incident_id?: string; fix_signature?: string | null } | undefined;
      return r?.task_id ? { taskId: String(r.task_id), incidentId: String(r.incident_id), fixSignature: r.fix_signature ?? null } : null;
    },
    async linkFix(incidentId, taskId) {
      await exec(linkTrunkFixSql(incidentId, taskId));
    },
    signatureOf: ciSignature,
  };
}

// ── Classification at ingestion (T10 → T25) ────────────────────────────────

export interface TrunkClassification {
  /** The failure's own signature (also the ci ledger row's trigger reason). */
  signature: string;
  /** The incident this delivery joined, if the trunk explains the failure. */
  incident: { id: string; opened: boolean; signature: string; rule: 'base_red' | 'threshold' | 'open_incident' } | null;
}

/**
 * Classify a red head. Never throws on a GitHub read: an unreadable check
 * set falls back to the placeholder signature and no incident, so the per-PR
 * CI path (bounded by its ledger) still runs.
 */
export async function classifyCiFailure(p: {
  workspaceId: string; repoFullName: string; baseRef: string | null; headSha: string; deliveryId: string;
  gitConfig: unknown; reader: GithubFactReader; exec?: Exec;
}): Promise<TrunkClassification> {
  const exec = p.exec ?? dbExec;
  // At test level: a shared (sharded) job name is not a shared failure.
  const runs = p.reader.checkRuns ? await p.reader.checkRuns(p.repoFullName, p.headSha, { tests: true }).catch(() => null) : null;
  const signature = ciSignature(runs?.tests ?? runs?.failing ?? []);
  const cfg = trunkBreakerConfig(p.gitConfig);
  if (!cfg.enabled || signature === UNKNOWN_CI_SIGNATURE || !p.baseRef) return { signature, incident: null };
  const baseRef = p.baseRef;
  const join = async (incidentSignature: string, rule: 'base_red' | 'threshold' | 'open_incident') => {
    const row = ((await exec(openOrJoinIncidentSql({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, baseRef, signature: incidentSignature, deliveryId: p.deliveryId }))).rows ?? [])[0] as { id: string; opened: boolean } | undefined;
    // On the recheck queue from the start: rechecked within the fallback even if no base suite reports.
    if (row) await scheduleTrunkRecheck(String(row.id));
    return row ? { signature, incident: { id: String(row.id), opened: !!row.opened, signature: incidentSignature, rule } } : { signature, incident: null };
  };

  // An incident already open on this base that explains the failure: join it.
  const open = ((await exec(openIncidentsForBaseSql(p.workspaceId, p.repoFullName, baseRef))).rows ?? []) as Array<{ id: string; signature: string }>;
  const explaining = open.find((i) => trunkExplains(signature, i.signature));
  if (explaining) return join(explaining.signature, 'open_incident');

  // (a) The base branch's own head fails the same checks now.
  const baseHead = p.reader.branchHead ? await p.reader.branchHead(p.repoFullName, baseRef).catch(() => null) : null;
  if (baseHead && baseHead !== p.headSha && p.reader.checkRuns) {
    const baseRuns = await p.reader.checkRuns(p.repoFullName, baseHead, { tests: true }).catch(() => null);
    const baseSignature = ciSignature(baseRuns?.tests ?? baseRuns?.failing ?? []);
    if (trunkExplains(signature, baseSignature)) return join(baseSignature, 'base_red');
  }

  // (b) Opt-in: enough distinct deliveries on this signature inside the window.
  if (cfg.minDeliveries) {
    const row = ((await exec(recentSignatureDeliveriesSql({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, signature, windowMinutes: cfg.windowMinutes, excludeDeliveryId: p.deliveryId }))).rows ?? [])[0] as { n: number } | undefined;
    if (Number(row?.n ?? 0) + 1 >= cfg.minDeliveries) return join(signature, 'threshold');
  }
  return { signature, incident: null };
}
