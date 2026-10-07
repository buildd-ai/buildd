/**
 * The trunk circuit breaker (docs/specs/workflow-state-kernel.md §5.8, §6.10,
 * T25/T26, S24, AC-15).
 *
 * A CI failure is classified by its signature: the normalised names of the
 * check runs that failed on the head. When the PR's base branch fails the same
 * checks on its own head (on by default), or, opted in, enough deliveries hit
 * the same signature inside a window, the failure is the trunk's, not the
 * PR's: the delivery joins one `trunk_incidents` row and goes
 * BLOCKED_ON_TRUNK (T25) instead of filing a per-PR CI attempt. One trunk-fix
 * task exists per incident (`dispatch_trunk_fix`, trunk-effects.ts). The
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
import type { Exec } from './kernel';
import type { GithubFactReader } from './facts';
import { UNKNOWN_CI_SIGNATURE, ciSignature, trunkExplains } from './trunk-signature';

export { UNKNOWN_CI_SIGNATURE, ciSignature, signatureChecks, trunkExplains, trunkRecovered } from './trunk-signature';

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

export function unresolvedIncidentsSql(limit: number): SQL {
  return sql`-- workflow:trunk_unresolved
SELECT id, workspace_id, repo_full_name, base_ref, signature FROM trunk_incidents
WHERE status <> 'resolved' ORDER BY updated_at LIMIT ${limit}::int`;
}

export function resolveIncidentSql(id: string): SQL {
  return sql`-- workflow:trunk_resolve
UPDATE trunk_incidents SET status = 'resolved', resolved_at = now(), updated_at = now()
WHERE id = ${id}::uuid AND status <> 'resolved'
RETURNING id`;
}

/** Deliveries still blocked on an incident that has resolved (this pass or an earlier, interrupted one). */
export function blockedOnResolvedSql(limit: number): SQL {
  return sql`-- workflow:trunk_blocked_on_resolved
SELECT d.id, d.workspace_id, d.repo_full_name, d.current_head_sha, d.trunk_incident_id, i.base_ref
FROM workflow_deliveries d JOIN trunk_incidents i ON i.id = d.trunk_incident_id
WHERE d.state = 'BLOCKED_ON_TRUNK' AND d.authority = 'kernel' AND i.status = 'resolved'
LIMIT ${limit}::int`;
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
  const runs = p.reader.checkRuns ? await p.reader.checkRuns(p.repoFullName, p.headSha).catch(() => null) : null;
  const signature = ciSignature(runs?.failing ?? []);
  const cfg = trunkBreakerConfig(p.gitConfig);
  if (!cfg.enabled || signature === UNKNOWN_CI_SIGNATURE || !p.baseRef) return { signature, incident: null };
  const baseRef = p.baseRef;
  const join = async (incidentSignature: string, rule: 'base_red' | 'threshold' | 'open_incident') => {
    const row = ((await exec(openOrJoinIncidentSql({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, baseRef, signature: incidentSignature, deliveryId: p.deliveryId }))).rows ?? [])[0] as { id: string; opened: boolean } | undefined;
    return row ? { signature, incident: { id: String(row.id), opened: !!row.opened, signature: incidentSignature, rule } } : { signature, incident: null };
  };

  // An incident already open on this base that explains the failure: join it.
  const open = ((await exec(openIncidentsForBaseSql(p.workspaceId, p.repoFullName, baseRef))).rows ?? []) as Array<{ id: string; signature: string }>;
  const explaining = open.find((i) => trunkExplains(signature, i.signature));
  if (explaining) return join(explaining.signature, 'open_incident');

  // (a) The base branch's own head fails the same checks now.
  const baseHead = p.reader.branchHead ? await p.reader.branchHead(p.repoFullName, baseRef).catch(() => null) : null;
  if (baseHead && baseHead !== p.headSha && p.reader.checkRuns) {
    const baseRuns = await p.reader.checkRuns(p.repoFullName, baseHead).catch(() => null);
    const baseSignature = ciSignature(baseRuns?.failing ?? []);
    if (trunkExplains(signature, baseSignature)) return join(baseSignature, 'base_red');
  }

  // (b) Opt-in: enough distinct deliveries on this signature inside the window.
  if (cfg.minDeliveries) {
    const row = ((await exec(recentSignatureDeliveriesSql({ workspaceId: p.workspaceId, repoFullName: p.repoFullName, signature, windowMinutes: cfg.windowMinutes, excludeDeliveryId: p.deliveryId }))).rows ?? [])[0] as { n: number } | undefined;
    if (Number(row?.n ?? 0) + 1 >= cfg.minDeliveries) return join(signature, 'threshold');
  }
  return { signature, incident: null };
}
