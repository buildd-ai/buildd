/**
 * POST /api/admin/operator: one owner recovery action (operator-recovery spec
 * §7.2, buildd-admin). The route has already passed `requirePlatformOwner`.
 *
 * In order: parse (closed capability set `orq-cap-v1`, closed params, a
 * required reason) → re-observe the target through the recovery families →
 * compare generation/revision and evidenceRevision (409 with the fresh row) →
 * the capability's precondition, budget and pause (422) → write the audit
 * INTENT → the shared action service → complete the audit with before and
 * after. An action never reports applied without its audit row: if the intent
 * cannot be written nothing runs, and a completion failure answers 500.
 */
import type { RecoveryCauseRow } from '@buildd/shared';
import type { RecoveryPanel } from '@buildd/shared';
import { effectiveCauseKey } from '@/lib/failure-incident-cause-key';
import {
  applyIncidentRecoveryAction, auditView, automationKeyOf, parseAdminRecoveryAction, validateRecoveryAction,
  type AdminRecoveryActionRequest, type RecoveryActionDeps, type RecoveryFresh, type RecoveryPrincipal,
} from '@/lib/failure-incident-recovery-actions';
import type { AutomationState } from '@/lib/failure-incident-recovery-automation';
import type { RepairFacts } from '@/lib/failure-incident-repairs';
import type { StoredIncident } from '@/lib/failure-incident-store';
import type { PlatformAdminAuditInput } from '@/lib/admin/audit';

/** Members re-observed per cause action. A cause bigger than this is re-observed by the sweep. */
export const MAX_REOBSERVED_MEMBERS = 20;

export interface OperatorActionDeps {
  findIncident(id: string): Promise<StoredIncident | null>;
  /** Re-observe one incident (assessIncident, source `click`); returns the row after. */
  reassess(id: string): Promise<StoredIncident | null>;
  /** Open incidents that group under the key now. */
  causeMembers(causeKey: string): Promise<StoredIncident[]>;
  /** The read model's row for the cause (platform-wide), or null. */
  causeRow(causeKey: string): Promise<RecoveryCauseRow | null>;
  automation(): Promise<AutomationState>;
  repairFacts(incident: StoredIncident, peers: StoredIncident[]): Promise<RepairFacts | null>;
  linkTask(params: { taskId: string } | { prNumber: number; workspaceId: string }): Promise<{ id: string; workspaceId: string; status: string } | null>;
  teams(workspaceIds: string[]): Promise<Map<string, string | null>>;
  auditIntent(event: PlatformAdminAuditInput): Promise<string>;
  auditComplete(id: string, after: Record<string, unknown>): Promise<boolean>;
  service: RecoveryActionDeps;
  now(): string;
}

type Body = Record<string, unknown>;
export type OperatorActionResponse = { status: 200 | 400 | 404 | 409 | 422 | 500; body: Body };

const automationView = (s: AutomationState, key: string | null): Body => ({
  key,
  revision: key ? s.revisions[key] ?? 'none' : null,
  value: key ? (key.includes(':pause:') ? s.pauses[key] ?? null : s.policy) : null,
  readError: s.readError,
  paused: s.paused,
});

function targetOf(req: AdminRecoveryActionRequest, causeKey: string | null): { targetType: PlatformAdminAuditInput['targetType']; targetId: string } {
  const t = req.target;
  if ('incidentId' in t) return { targetType: 'incident', targetId: t.incidentId };
  if ('causeKey' in t) return { targetType: 'cause', targetId: t.causeKey };
  return { targetType: 'automation', targetId: automationKeyOf(req.params, causeKey) ?? 'operator-recovery' };
}

export async function handleOperatorRecoveryAction(
  deps: OperatorActionDeps,
  owner: { accountId: string; operatorLabel: string | null },
  rawBody: unknown,
): Promise<OperatorActionResponse> {
  const parsed = parseAdminRecoveryAction(rawBody);
  if (!parsed.ok) return { status: 400, body: { error: parsed.error } };
  const req = parsed.request;
  const principal: RecoveryPrincipal = { kind: 'platform_admin', accountId: owner.accountId, operatorLabel: owner.operatorLabel };

  // ── Re-observe (FIR §5 rule 1) ───────────────────────────────────────────
  let incident: StoredIncident | null = null;
  let causeKey: string | null = null;
  let members: StoredIncident[] = [];
  const t = req.target;
  if ('incidentId' in t) {
    if (!(await deps.findIncident(t.incidentId))) return { status: 404, body: { error: 'Incident not found' } };
    incident = await deps.reassess(t.incidentId);
    if (!incident) return { status: 404, body: { error: 'Incident not found' } };
    causeKey = effectiveCauseKey(incident).key;
    members = await deps.causeMembers(causeKey);
    if (!members.some(m => m.id === incident!.id)) members = [incident, ...members];
  } else if ('causeKey' in t) {
    causeKey = t.causeKey;
    const before = await deps.causeMembers(causeKey);
    if (before.length === 0) return { status: 404, body: { error: 'Cause not found' } };
    for (const m of before.slice(0, MAX_REOBSERVED_MEMBERS)) await deps.reassess(m.id);
    members = await deps.causeMembers(causeKey);
  }
  const automation = await deps.automation();
  const peers = incident ? members.filter(m => m.id !== incident!.id) : [];
  const lead = !incident && members.length ? (await import('@/lib/failure-incident-repairs')).leadIncidentOf(members) : null;
  const subject = incident ?? lead;

  const p = req.params;
  const teamMap = await deps.teams([...new Set([...members, ...(subject ? [subject] : [])].map(m => m.workspaceId).filter((x): x is string => !!x))]);
  const mergeMembers = p.capability === 'regroup' && 'mergeInto' in p ? await deps.causeMembers(p.mergeInto) : null;
  if (mergeMembers) {
    const more = await deps.teams(mergeMembers.map(m => m.workspaceId).filter((x): x is string => !!x));
    for (const [k, v] of more) teamMap.set(k, v);
  }
  const rowBefore = causeKey ? await deps.causeRow(causeKey) : null;
  const fresh: RecoveryFresh = {
    now: deps.now(),
    incident: subject,
    members,
    causeKey,
    automation,
    repairFacts: p.capability === 'run_repair' && incident ? await deps.repairFacts(incident, peers) : null,
    tier: rowBefore?.rank.tier ?? null,
    linkTask: p.capability === 'link_fix' ? await deps.linkTask('taskId' in p ? { taskId: p.taskId } : { prNumber: p.prNumber, workspaceId: p.workspaceId }) : null,
    mergeMembers,
    teamOf: ws => (ws ? teamMap.get(ws) ?? null : null),
  };

  // ── Validate (§8.2) ──────────────────────────────────────────────────────
  const verdict = validateRecoveryAction(principal, req, fresh);
  const autoKey = automationKeyOf(p, causeKey);
  const freshView = () => (rowBefore ? { cause: rowBefore } : { cause: null, automation: automationView(automation, autoKey) });
  if (verdict.result === 'stale') return { status: 409, body: { result: 'stale', detail: verdict.detail, ...freshView() } };
  if (verdict.result !== 'ok') return { status: 422, body: { result: 'rejected', reason: verdict.result, detail: verdict.detail, ...freshView() } };

  // ── Audit intent, then act, then complete (§7.2 step 7, OR-2) ────────────
  const { targetType, targetId } = targetOf(req, causeKey);
  const teamIds = new Set(members.map(m => fresh.teamOf!(m.workspaceId)));
  const request = { capability: req.capability, target: req.target, evidenceRevision: req.evidenceRevision, params: req.params };
  const before = rowBefore ? auditView(rowBefore)! : automationView(automation, autoKey);
  const who = { operatorLabel: owner.operatorLabel, reason: req.reason, request, ...(p.capability === 'run_repair' && p.overridePause ? { overridePause: true } : {}) };
  let auditId: string;
  try {
    auditId = await deps.auditIntent({
      actorAccountId: owner.accountId,
      action: `recovery.${req.capability}`,
      targetType, targetId,
      teamId: teamIds.size === 1 ? [...teamIds][0] ?? null : null,
      before,
      after: who,
    });
  } catch (err) {
    console.error('[admin/operator] audit intent failed; nothing was applied', err instanceof Error ? err.message : err);
    return { status: 500, body: { error: 'The audit row could not be written, so nothing was applied.' } };
  }

  let result: Awaited<ReturnType<typeof applyIncidentRecoveryAction>>;
  try {
    result = await applyIncidentRecoveryAction(deps.service, principal, req, fresh, { auditId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await deps.auditComplete(auditId, { ...who, phase: 'failed', error: message.slice(0, 300) }).catch(() => false);
    console.error('[admin/operator] recovery action failed', message);
    return { status: 500, body: { error: 'The action failed.', detail: message.slice(0, 300), auditId } };
  }

  const afterKey = p.capability === 'regroup' && 'mergeInto' in p ? p.mergeInto : causeKey;
  const rowAfter = afterKey ? await deps.causeRow(afterKey).catch(() => null) : null;
  const automationAfter = rowAfter ? null : await deps.automation();
  const afterView = rowAfter ? auditView(rowAfter)! : automationView(automationAfter!, autoKey);
  const completed = await deps.auditComplete(auditId, {
    ...afterView,
    ...who,
    phase: result.result === 'stale' ? 'not_applied' : result.result,
    ...(result.result !== 'stale' && result.attempt ? { attempt: result.attempt } : {}),
  }).catch(() => false);
  if (!completed) return { status: 500, body: { error: 'The action ran but its audit row could not be completed.', auditId } };

  const view = rowAfter ? { cause: rowAfter } : { cause: null, automation: automationView(automationAfter!, autoKey) };
  if (result.result === 'stale') return { status: 409, body: { result: 'stale', detail: result.detail, ...view } };
  if (result.result === 'duplicate') return { status: 200, body: { result: 'duplicate', auditId, ...view } };
  return { status: 200, body: { result: 'applied', auditId, ...view, ...(result.attempt ? { attempt: result.attempt } : {}) } };
}

export type { RecoveryPanel };
