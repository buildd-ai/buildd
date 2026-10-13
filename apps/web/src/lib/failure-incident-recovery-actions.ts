/**
 * Recovery actions: one validator and one action service for every principal
 * (operator-recovery spec §7.2, §8.1, §8.2, operator console; FIR §9).
 *
 *  - `parseAdminRecoveryAction`: the closed capability set `orq-cap-v1`, its
 *    closed params and the required reason. Anything else is a 400.
 *  - `validateRecoveryAction(principal, request, fresh)`: on facts re-read at
 *    click time, `ok` or exactly one of stale, precondition, budget, paused,
 *    not_supported. The platform owner's click, a team admin's click and a
 *    model's suggestion all go through it; they share the service, never the
 *    authorization (each route authorizes its own principal first).
 *  - `applyIncidentRecoveryAction`: executes an `ok` request through the
 *    existing writers only: the incident CAS, the recovery loop's repair
 *    writers, the fix-task path, the decision ledger and the automation CAS.
 *  - `availableActions`: what the read model offers for a cause right now.
 *
 * Pure, except the service, which only touches its injected deps.
 */
import { createHash } from 'node:crypto';
import type {
  AdminRecoveryCapability,
  AvailableAction,
  FailureIncidentRecovery,
  FailureRecoveryCapability,
  FailureRecoveryRef,
} from '@buildd/shared';
import { causeKeyFrom, causeScope, ruleCauseKey } from './failure-incident-cause-key';
import {
  applyPolicyPatch, MAX_PAUSE_MS, pauseFor, pauseKey, POLICY_KEY,
  type AutomationState, type AutoRepairMode, type PauseScope, type PolicyPatch,
} from './failure-incident-recovery-automation';
import {
  readRecovery, recoveryActionKey, RECOVERY_REPAIR_RECHECK_MINUTES, MAX_RECOVERY_ATTEMPTS, MAX_RECOVERY_SPENT_KEYS,
  runPlannedRepair, type RecoveryEffects,
} from './failure-incident-recovery';
import { buildAttemptEvent, REPAIR_KINDS, type RecoveryEventsPort, type RepairKind } from './failure-incident-recovery-events';
import { checkRepair, leadIncidentOf, REPAIRS, repairAppliesTo, repairTarget, type RepairFacts } from './failure-incident-repairs';
import { applyIncidentAction, type IncidentStorePort, type StoredIncident } from './failure-incident-store';

export const ORQ_CAP_VERSION = 'orq-cap-v1';

export const ADMIN_RECOVERY_CAPABILITIES: readonly AdminRecoveryCapability[] = [
  'run_repair', 'retry_recovery', 'decide', 'link_fix', 'queue_fix', 'regroup',
  'set_priority', 'pause_automation', 'resume_automation', 'set_policy',
];

/** FIR's typed options this service applies itself. The rest are done where their subject lives (a PR, a task). */
export const APPLIED_DECISION_OPTIONS: ReadonlySet<FailureRecoveryCapability> = new Set(['dismiss', 'retry_recovery']);

/** §8.1 retry_recovery: at most this many budget extensions per generation. */
export const MAX_BUDGET_EXTENSIONS = 2;
/** §5.6 set_priority limits. */
export const MAX_PRIORITY_MS = 7 * 86_400_000;
export const MAX_TIER0_DEMOTE_MS = 24 * 3_600_000;
export const PRIORITY_CAPABILITY = 'operator_recovery.priority';

// ── Principals and requests ─────────────────────────────────────────────────

export type RecoveryPrincipal =
  /** The platform owner through POST /api/admin/operator. `operatorLabel` is asserted by the admin app, recorded, never trusted. */
  | { kind: 'platform_admin'; accountId: string; operatorLabel: string | null }
  /** A team admin through the incident page (FIR (b) route), already scoped to their own team. */
  | { kind: 'team'; accountId: string | null; userId: string | null }
  /** A model's `repair_suggestion` (B3). `promoted`: its decision kind left shadow (§6.5). */
  | { kind: 'model'; decisionId: string; promoted: boolean };

export type RecoveryTarget =
  | { causeKey: string; revision: string }
  | { incidentId: string; generation: number }
  /** Platform, rule and model scopes of pause/resume, and set_policy: no cause row; the CAS token is the key's `updatedAt`. */
  | { automation: true };

export type AdminRecoveryParams =
  | { capability: 'run_repair'; repair: RepairKind; overridePause?: boolean }
  | { capability: 'retry_recovery'; extendBudgetBy?: 1 | 2 }
  | { capability: 'decide'; option: FailureRecoveryCapability }
  | { capability: 'link_fix'; taskId: string }
  | { capability: 'link_fix'; prNumber: number; workspaceId: string }
  | { capability: 'queue_fix'; title?: string }
  | { capability: 'regroup'; mergeInto: string }
  | { capability: 'regroup'; split: string[] }
  | { capability: 'set_priority'; mode: 'pin_top' | 'demote' | 'snooze'; until: string }
  | { capability: 'pause_automation'; scope: PauseScope['kind']; rule?: string; until: string }
  | { capability: 'resume_automation'; scope: PauseScope['kind']; rule?: string }
  | { capability: 'set_policy'; patch: PolicyPatch };

export interface AdminRecoveryActionRequest {
  capability: AdminRecoveryCapability;
  target: RecoveryTarget;
  evidenceRevision: string;
  params: AdminRecoveryParams;
  reason: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CAUSE_KEY_RE = /^c1:[0-9a-f]{20}$/;
const RULE_RE = /^[a-z_]{3,40}$/;
const DECISION_OPTIONS: readonly FailureRecoveryCapability[] = ['dismiss', 'retry_recovery', 'cancel_attempt', 'narrow_subject_manifest', 'narrow_blocker_manifest', 'open_blocker'];
const PAUSE_SCOPES: readonly PauseScope['kind'][] = ['platform', 'rule', 'cause', 'model'];
const MODES: readonly AutoRepairMode[] = ['off', 'shadow', 'on'];

/** Which target each capability takes (§8.1). */
const TARGET_OF: Record<AdminRecoveryCapability, 'incident' | 'cause' | 'scope'> = {
  run_repair: 'incident', retry_recovery: 'incident', decide: 'incident',
  link_fix: 'cause', queue_fix: 'cause', regroup: 'cause', set_priority: 'cause',
  pause_automation: 'scope', resume_automation: 'scope', set_policy: 'scope',
};

type Parsed = { ok: true; request: AdminRecoveryActionRequest } | { ok: false; error: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, allowed: readonly string[]) => Object.keys(o).find(k => !allowed.includes(k)) ?? null;
const isIso = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /^\d{4}-\d{2}-\d{2}T/.test(v);

function parseParams(capability: AdminRecoveryCapability, raw: unknown): AdminRecoveryParams | string {
  const p = raw === undefined ? {} : raw;
  if (!isObj(p)) return 'params must be an object';
  const closed = (keys: readonly string[]) => { const k = onlyKeys(p, keys); return k ? `unknown param "${k}" for ${capability}` : null; };
  switch (capability) {
    case 'run_repair': {
      const bad = closed(['repair', 'overridePause']); if (bad) return bad;
      if (typeof p.repair !== 'string' || !(REPAIR_KINDS as readonly string[]).includes(p.repair)) return `params.repair must be one of ${REPAIR_KINDS.join(', ')}`;
      if (p.overridePause !== undefined && typeof p.overridePause !== 'boolean') return 'params.overridePause must be a boolean';
      return { capability, repair: p.repair as RepairKind, ...(p.overridePause !== undefined ? { overridePause: p.overridePause as boolean } : {}) };
    }
    case 'retry_recovery': {
      const bad = closed(['extendBudgetBy']); if (bad) return bad;
      if (p.extendBudgetBy !== undefined && p.extendBudgetBy !== 1 && p.extendBudgetBy !== 2) return 'params.extendBudgetBy must be 1 or 2';
      return { capability, ...(p.extendBudgetBy !== undefined ? { extendBudgetBy: p.extendBudgetBy as 1 | 2 } : {}) };
    }
    case 'decide': {
      const bad = closed(['option']); if (bad) return bad;
      if (typeof p.option !== 'string' || !(DECISION_OPTIONS as readonly string[]).includes(p.option)) return `params.option must be one of ${DECISION_OPTIONS.join(', ')}`;
      return { capability, option: p.option as FailureRecoveryCapability };
    }
    case 'link_fix': {
      if ('taskId' in p) {
        const bad = closed(['taskId']); if (bad) return bad;
        if (typeof p.taskId !== 'string' || !UUID_RE.test(p.taskId)) return 'params.taskId must be a UUID';
        return { capability, taskId: p.taskId };
      }
      const bad = closed(['prNumber', 'workspaceId']); if (bad) return bad;
      if (typeof p.prNumber !== 'number' || !Number.isInteger(p.prNumber) || p.prNumber < 1) return 'params needs taskId, or prNumber and workspaceId';
      if (typeof p.workspaceId !== 'string' || !UUID_RE.test(p.workspaceId)) return 'params.workspaceId must be a UUID';
      return { capability, prNumber: p.prNumber, workspaceId: p.workspaceId };
    }
    case 'queue_fix': {
      const bad = closed(['title']); if (bad) return bad;
      if (p.title !== undefined && (typeof p.title !== 'string' || p.title.length < 3 || p.title.length > 200)) return 'params.title must be 3 to 200 characters';
      return { capability, ...(typeof p.title === 'string' ? { title: p.title } : {}) };
    }
    case 'regroup': {
      if ('mergeInto' in p) {
        const bad = closed(['mergeInto']); if (bad) return bad;
        if (typeof p.mergeInto !== 'string' || !CAUSE_KEY_RE.test(p.mergeInto)) return 'params.mergeInto must be a cause key';
        return { capability, mergeInto: p.mergeInto };
      }
      const bad = closed(['split']); if (bad) return bad;
      if (!Array.isArray(p.split) || p.split.length === 0 || p.split.length > 50 || !p.split.every(x => typeof x === 'string' && UUID_RE.test(x))) return 'params needs mergeInto, or split: 1 to 50 incident UUIDs';
      return { capability, split: p.split as string[] };
    }
    case 'set_priority': {
      const bad = closed(['mode', 'until']); if (bad) return bad;
      if (p.mode !== 'pin_top' && p.mode !== 'demote' && p.mode !== 'snooze') return 'params.mode must be pin_top, demote or snooze';
      if (!isIso(p.until)) return 'params.until must be an ISO timestamp';
      return { capability, mode: p.mode, until: new Date(p.until).toISOString() };
    }
    case 'pause_automation':
    case 'resume_automation': {
      const bad = closed(capability === 'pause_automation' ? ['scope', 'rule', 'until'] : ['scope', 'rule']); if (bad) return bad;
      if (typeof p.scope !== 'string' || !(PAUSE_SCOPES as readonly string[]).includes(p.scope)) return `params.scope must be one of ${PAUSE_SCOPES.join(', ')}`;
      if (p.scope === 'rule' && (typeof p.rule !== 'string' || !RULE_RE.test(p.rule))) return 'params.rule is required for scope rule';
      if (p.scope !== 'rule' && p.rule !== undefined) return 'params.rule is only for scope rule';
      const rule = p.scope === 'rule' ? { rule: p.rule as string } : {};
      if (capability === 'resume_automation') return { capability, scope: p.scope as PauseScope['kind'], ...rule };
      if (!isIso(p.until)) return 'params.until must be an ISO timestamp';
      return { capability, scope: p.scope as PauseScope['kind'], ...rule, until: new Date(p.until).toISOString() };
    }
    case 'set_policy': {
      const bad = closed(['rule', 'budgetLimit', 'backoffMinutes', 'episodeDeadlineHours', 'autoRepair', 'repair', 'model']); if (bad) return bad;
      if (p.rule !== undefined && (typeof p.rule !== 'string' || !RULE_RE.test(p.rule))) return 'params.rule must be a rule name';
      if (p.repair !== undefined) {
        if (!isObj(p.repair) || onlyKeys(p.repair, ['kind', 'mode']) || typeof p.repair.kind !== 'string' || !(REPAIR_KINDS as readonly string[]).includes(p.repair.kind) || !(MODES as readonly unknown[]).includes(p.repair.mode)) {
          return 'params.repair must be { kind: RepairKind, mode: off | shadow | on }';
        }
      }
      if (p.model !== undefined && (!isObj(p.model) || onlyKeys(p.model, ['dailyUsd', 'dailyCalls', 'timeoutMs']))) return 'params.model takes dailyUsd, dailyCalls and timeoutMs only';
      if (Object.keys(p).length === 0) return 'set_policy needs at least one field';
      return { capability, patch: p as PolicyPatch };
    }
  }
}

/** Parse a POST body (§7.2). Closed at every level: an unknown key is a 400, never ignored. */
export function parseAdminRecoveryAction(body: unknown): Parsed {
  if (!isObj(body)) return { ok: false, error: 'body must be a JSON object' };
  const extra = onlyKeys(body, ['capability', 'target', 'evidenceRevision', 'params', 'reason']);
  if (extra) return { ok: false, error: `unknown field "${extra}"` };
  const capability = body.capability;
  if (typeof capability !== 'string' || !(ADMIN_RECOVERY_CAPABILITIES as readonly string[]).includes(capability)) {
    return { ok: false, error: `capability must be one of ${ADMIN_RECOVERY_CAPABILITIES.join(', ')} (${ORQ_CAP_VERSION})` };
  }
  const cap = capability as AdminRecoveryCapability;
  if (typeof body.reason !== 'string' || body.reason.trim().length < 3 || body.reason.length > 500) return { ok: false, error: 'reason is required: 3 to 500 characters' };
  if (typeof body.evidenceRevision !== 'string' || body.evidenceRevision.length === 0 || body.evidenceRevision.length > 200) return { ok: false, error: 'evidenceRevision is required' };
  const t = body.target;
  let target: RecoveryTarget;
  const want = TARGET_OF[cap];
  if (isObj(t) && 'incidentId' in t) {
    if (onlyKeys(t, ['incidentId', 'generation']) || typeof t.incidentId !== 'string' || !UUID_RE.test(t.incidentId) || typeof t.generation !== 'number' || !Number.isInteger(t.generation)) {
      return { ok: false, error: 'target must be { incidentId: UUID, generation: integer }' };
    }
    target = { incidentId: t.incidentId, generation: t.generation };
  } else if (isObj(t) && 'causeKey' in t) {
    if (onlyKeys(t, ['causeKey', 'revision']) || typeof t.causeKey !== 'string' || !CAUSE_KEY_RE.test(t.causeKey) || typeof t.revision !== 'string' || !t.revision) {
      return { ok: false, error: 'target must be { causeKey: c1:<20 hex>, revision }' };
    }
    target = { causeKey: t.causeKey, revision: t.revision };
  } else if (isObj(t) && t.automation === true && !onlyKeys(t, ['automation'])) {
    target = { automation: true };
  } else {
    return { ok: false, error: 'target must name an incident, a cause or the automation switch' };
  }
  const kind = 'incidentId' in target ? 'incident' : 'causeKey' in target ? 'cause' : 'scope';
  if (want === 'incident' && kind !== 'incident') return { ok: false, error: `${cap} targets an incident` };
  if (want === 'cause' && kind !== 'cause') return { ok: false, error: `${cap} targets a cause` };
  if (want === 'scope' && kind === 'incident') return { ok: false, error: `${cap} targets a cause or the automation switch` };
  const params = parseParams(cap, body.params);
  if (typeof params === 'string') return { ok: false, error: params };
  if (want === 'scope' && cap !== 'set_policy') {
    const scope = (params as { scope: PauseScope['kind'] }).scope;
    if ((scope === 'cause') !== (kind === 'cause')) return { ok: false, error: 'scope cause targets that cause; the other scopes target { automation: true }' };
  }
  if (cap === 'set_policy' && kind !== 'scope') return { ok: false, error: 'set_policy targets { automation: true }' };
  return { ok: true, request: { capability: cap, target, evidenceRevision: body.evidenceRevision, params, reason: body.reason.trim() } };
}

// ── Fresh facts and the validator ───────────────────────────────────────────

export interface RecoveryFresh {
  now: string;
  /** The target incident after re-observation; for a cause, its lead. */
  incident: StoredIncident | null;
  /** The cause's open (and recently resolved) members, the incident's cause for an incident target. */
  members: StoredIncident[];
  causeKey: string | null;
  automation: AutomationState;
  /** run_repair only: the repair's facts read now. */
  repairFacts?: RepairFacts | null;
  /** The cause's rank tier (set_priority's §5.6 limit), when known. */
  tier?: number | null;
  /** link_fix: the task the params name, if it exists. */
  linkTask?: { id: string; workspaceId: string; status: string } | null;
  /** regroup mergeInto: the members of the other cause. */
  mergeMembers?: StoredIncident[] | null;
  /** The team of each workspace (regroup's cross-team check). */
  teamOf?: (workspaceId: string | null) => string | null;
}

export type RecoveryValidation =
  | { result: 'ok' }
  | { result: 'stale'; detail: string }
  | { result: 'precondition' | 'budget' | 'paused' | 'not_supported'; detail: string };

/** The cause's CAS token: a hash of member (incidentId, version) pairs. Same as the read model's. */
export function causeRevisionOf(members: ReadonlyArray<{ id: string; version: number }>): string {
  return createHash('sha256').update(members.map(m => `${m.id}:${m.version}`).sort().join(',')).digest('hex').slice(0, 16);
}

/** The cause's evidence revision: a hash of each member's last observation. */
export function causeEvidenceRevisionOf(members: ReadonlyArray<Pick<StoredIncident, 'id' | 'recovery'>>): string {
  const pairs = members.map(m => `${m.id}:${readRecovery(m)?.observation.evidenceRevision ?? 'none'}`).sort().join(',');
  return createHash('sha256').update(pairs).digest('hex').slice(0, 16);
}

/** The automation key a scope request writes, and its current CAS token (`none` when absent). */
export function automationKeyOf(params: AdminRecoveryParams, causeKey: string | null): string | null {
  if (params.capability === 'set_policy') return POLICY_KEY;
  if (params.capability !== 'pause_automation' && params.capability !== 'resume_automation') return null;
  switch (params.scope) {
    case 'platform': return pauseKey({ kind: 'platform' });
    case 'model': return pauseKey({ kind: 'model' });
    case 'rule': return pauseKey({ kind: 'rule', rule: params.rule! });
    case 'cause': return causeKey ? pauseKey({ kind: 'cause', causeKey }) : null;
  }
}

export const automationRevisionOf = (state: AutomationState, key: string) => state.revisions[key] ?? 'none';

const live = (r: FailureIncidentRecovery | null) => !!r && r.state !== 'recovered';
const isTeamCapability = (c: AdminRecoveryCapability) => c === 'decide' || c === 'retry_recovery';

/** Pure. One validator for every principal (§8.2). */
export function validateRecoveryAction(principal: RecoveryPrincipal, req: AdminRecoveryActionRequest, fresh: RecoveryFresh): RecoveryValidation {
  const p = req.params;

  // Who may ask for what. Authorization is the route's; this is the capability fence.
  if (principal.kind === 'team' && !isTeamCapability(req.capability)) return { result: 'not_supported', detail: `${req.capability} is a platform owner action.` };
  if (principal.kind === 'model') {
    if (p.capability !== 'run_repair') return { result: 'not_supported', detail: 'A model may only suggest an allowlisted repair.' };
    if (!principal.promoted) return { result: 'not_supported', detail: 'This decision kind is in shadow: it records, it never acts (OR-5).' };
    if (!REPAIRS[p.repair].autoEligible) return { result: 'not_supported', detail: `${p.repair} is not eligible for automatic selection.` };
  }

  // Stale: the owner acted on facts that moved.
  const t = req.target;
  if ('incidentId' in t) {
    const r = fresh.incident ? readRecovery(fresh.incident) : null;
    if (!fresh.incident) return { result: 'stale', detail: 'The incident no longer exists.' };
    if ((r?.generation ?? 0) !== t.generation) return { result: 'stale', detail: `The incident moved to generation ${r?.generation ?? 0}.` };
    if ((r?.observation.evidenceRevision ?? 'none') !== req.evidenceRevision) return { result: 'stale', detail: 'The facts changed since this was offered.' };
  } else if ('causeKey' in t) {
    if (fresh.members.length === 0) return { result: 'stale', detail: 'No incident groups under this cause any more.' };
    if (causeRevisionOf(fresh.members) !== t.revision) return { result: 'stale', detail: 'The cause changed since this was offered.' };
    // A cause's pause switch carries the switch's own CAS token; every other cause action the members' evidence.
    const key = automationKeyOf(p, fresh.causeKey);
    if (key ? automationRevisionOf(fresh.automation, key) !== req.evidenceRevision : causeEvidenceRevisionOf(fresh.members) !== req.evidenceRevision) {
      return { result: 'stale', detail: key ? 'The switch changed since this was offered.' : 'The facts changed since this was offered.' };
    }
  } else {
    const key = automationKeyOf(p, fresh.causeKey);
    if (key && automationRevisionOf(fresh.automation, key) !== req.evidenceRevision) return { result: 'stale', detail: 'The switch changed since this was offered.' };
  }

  const nowMs = Date.parse(fresh.now);
  const incident = fresh.incident;
  const r = incident ? readRecovery(incident) : null;

  switch (p.capability) {
    case 'run_repair': {
      if (!incident || !r) return { result: 'precondition', detail: 'The incident has no assessment to repair against.' };
      if (!live(r) || incident.status === 'resolved') return { result: 'precondition', detail: 'The incident has recovered.' };
      if (!repairAppliesTo(p.repair, incident.rule)) return { result: 'not_supported', detail: `${p.repair} does not apply to ${incident.rule}.` };
      const spec = REPAIRS[p.repair];
      if (spec.shared && fresh.members.length > 1) {
        const lead = leadIncidentOf(fresh.members);
        if (lead && lead.id !== incident.id) return { result: 'precondition', detail: `This repair runs once for the cause, on incident ${lead.id.slice(0, 8)}.` };
      }
      if (r.budget.spent >= r.budget.limit) return { result: 'budget', detail: `${r.budget.spent} of ${r.budget.limit} repairs used this generation.` };
      const scope = pauseFor(fresh.automation, { rule: incident.rule, causeKey: fresh.causeKey });
      const modelPaused = principal.kind === 'model' && (fresh.automation.paused.model || fresh.automation.readError);
      if (modelPaused) return { result: 'paused', detail: 'Model-selected repairs are paused.' };
      if (scope && !(principal.kind === 'platform_admin' && p.overridePause === true)) {
        return { result: 'paused', detail: fresh.automation.readError ? 'The pause switch could not be read, so repairs are paused.' : `Automatic repair is paused (${scope.kind}). Pass overridePause to run it anyway.` };
      }
      if (!fresh.repairFacts) return { result: 'precondition', detail: "Buildd couldn't read the facts this repair needs." };
      const why = checkRepair(p.repair, fresh.repairFacts);
      return why ? { result: 'precondition', detail: why } : { result: 'ok' };
    }
    case 'retry_recovery': {
      if (!incident || !r) return { result: 'precondition', detail: 'The incident has no assessment to retry.' };
      if (r.state !== 'needs_decision' && r.state !== 'inconclusive' && r.state !== 'needs_operator') return { result: 'precondition', detail: `Retry is for a stuck recovery; this one is ${r.state}.` };
      if (p.extendBudgetBy && (r.budget.extended ?? 0) + p.extendBudgetBy > MAX_BUDGET_EXTENSIONS) {
        return { result: 'budget', detail: `The budget was already extended ${r.budget.extended ?? 0} time(s) this generation; at most ${MAX_BUDGET_EXTENSIONS}.` };
      }
      return { result: 'ok' };
    }
    case 'decide': {
      if (!incident || !r) return { result: 'precondition', detail: 'The incident has no decision.' };
      if (r.state !== 'needs_decision' || !r.decision?.options.some(o => o.capability === p.option)) return { result: 'precondition', detail: 'That option is not offered on the current assessment.' };
      if (!APPLIED_DECISION_OPTIONS.has(p.option)) return { result: 'not_supported', detail: 'This choice is made where its subject lives (the PR or the task).' };
      return { result: 'ok' };
    }
    case 'link_fix':
    case 'queue_fix': {
      const fixLive = fresh.members.some(m => !!m.linkedFixTaskId && m.status !== 'resolved');
      if (fixLive) return { result: 'precondition', detail: 'The cause already has a fix linked.' };
      if (p.capability === 'queue_fix') {
        const platformDefect = fresh.members.some(m => causeScope(m) === 'platform' || readRecovery(m)?.cause.ownership === 'infrastructure');
        if (!platformDefect) return { result: 'precondition', detail: 'queue_fix is for a platform defect or a cause that needs code.' };
        return { result: 'ok' };
      }
      if (!fresh.linkTask) return { result: 'precondition', detail: 'That task or PR was not found.' };
      if (!fresh.members.some(m => m.workspaceId === fresh.linkTask!.workspaceId)) return { result: 'precondition', detail: "The fix must belong to a member incident's workspace." };
      return { result: 'ok' };
    }
    case 'regroup': {
      if ('mergeInto' in p) {
        if (p.mergeInto === fresh.causeKey) return { result: 'precondition', detail: 'A cause cannot merge into itself.' };
        const other = fresh.mergeMembers ?? [];
        if (other.length === 0) return { result: 'precondition', detail: 'The cause to merge into has no incidents.' };
        const wsScoped = (ms: StoredIncident[]) => ms.every(m => causeScope(m) !== 'platform');
        const teams = (ms: StoredIncident[]) => new Set(ms.map(m => fresh.teamOf?.(m.workspaceId) ?? null));
        if (wsScoped(fresh.members) && wsScoped(other)) {
          const a = teams(fresh.members), b = teams(other);
          if ([...a].some(x => !b.has(x)) || [...b].some(x => !a.has(x))) return { result: 'precondition', detail: 'Two workspace causes from different teams are never merged.' };
        }
        return { result: 'ok' };
      }
      const ids = new Set(fresh.members.map(m => m.id));
      if (!p.split.every(id => ids.has(id))) return { result: 'precondition', detail: 'Only member incidents can be split out.' };
      if (p.split.length >= fresh.members.length) return { result: 'precondition', detail: 'Splitting out every member leaves nothing behind.' };
      return { result: 'ok' };
    }
    case 'set_priority': {
      const why = priorityLimit(p.mode, p.until, fresh.tier ?? null, nowMs);
      return why ? { result: 'precondition', detail: why } : { result: 'ok' };
    }
    case 'pause_automation': {
      const until = Date.parse(p.until);
      if (until <= nowMs) return { result: 'precondition', detail: 'until must be in the future.' };
      if (until - nowMs > MAX_PAUSE_MS) return { result: 'precondition', detail: 'A pause lasts at most 7 days.' };
      return { result: 'ok' };
    }
    case 'resume_automation': {
      const key = automationKeyOf(p, fresh.causeKey);
      if (!key || !fresh.automation.pauses[key]) return { result: 'precondition', detail: 'That scope is not paused.' };
      return { result: 'ok' };
    }
    case 'set_policy': {
      const next = applyPolicyPatch(fresh.automation.policy, p.patch);
      return next.ok ? { result: 'ok' } : { result: 'precondition', detail: next.error };
    }
  }
}

/** Pure. §5.6: `until` ≤ 7 days ahead; on tier 0, snooze and demote ≤ 24 h. Null: within the limits. */
export function priorityLimit(mode: 'pin_top' | 'demote' | 'snooze', until: string, tier: number | null, nowMs: number): string | null {
  const ms = Date.parse(until) - nowMs;
  if (ms <= 0) return 'until must be in the future.';
  if (ms > MAX_PRIORITY_MS) return 'An override lasts at most 7 days.';
  if (tier === 0 && mode !== 'pin_top' && ms > MAX_TIER0_DEMOTE_MS) return 'A safety problem can be snoozed or demoted for at most 24 hours.';
  return null;
}

// ── The service ─────────────────────────────────────────────────────────────

export interface RecoveryActionDeps {
  port: Pick<IncidentStorePort, 'findById' | 'compareAndSwap'>;
  effects: RecoveryEffects;
  events?: RecoveryEventsPort;
  /** Re-observe one incident (assessIncident, source `click`). */
  reassess(incidentId: string): Promise<StoredIncident | null>;
  /** The automation CAS (`compareAndSetAutomation`). */
  writeAutomation(input: { key: string; value: unknown | null; expected: string | null; expiresAt: Date | null }): Promise<string | null>;
  /** A §5.6 override row in the decision ledger. Returns its id, null on failure. */
  recordPriority(input: { causeKey: string; teamId: string; mode: string; until: string; reason: string; by: string; accountId: string | null }): Promise<string | null>;
  now(): string;
}

export type RecoveryActionResult =
  | { result: 'applied'; attempt?: { actionKey: string }; detail?: string; fixTaskId?: string | null }
  | { result: 'duplicate'; attempt?: { actionKey: string } }
  /** The CAS lost to another writer between validation and the write: answer with the fresh state. */
  | { result: 'stale'; detail: string };

const actorOf = (p: RecoveryPrincipal) =>
  p.kind === 'platform_admin' ? `platform_admin:${p.accountId}` : p.kind === 'team' ? `team:${p.accountId ?? p.userId ?? 'unknown'}` : `model:${p.decisionId}`;

const minutesAfter = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();

/**
 * Apply a request `validateRecoveryAction` answered `ok` on `fresh`. Writes go
 * through the incident CAS on the version validated, so a race answers
 * `stale` (or `duplicate`, when the race spent the same repair) instead of
 * acting twice. `auditId` is the owner's audit intent row, stored as the
 * operator membership's decision id on a regroup.
 */
export async function applyIncidentRecoveryAction(
  deps: RecoveryActionDeps,
  principal: RecoveryPrincipal,
  req: AdminRecoveryActionRequest,
  fresh: RecoveryFresh,
  opts: { auditId?: string | null } = {},
): Promise<RecoveryActionResult> {
  const p = req.params;
  const now = deps.now();
  const incident = fresh.incident;
  const by = principal.kind === 'platform_admin' ? (principal.operatorLabel ?? principal.accountId) : actorOf(principal);

  switch (p.capability) {
    case 'run_repair': {
      const row = incident!;
      const r = readRecovery(row)!;
      const spec = REPAIRS[p.repair];
      const { subject, params } = repairTarget(p.repair, fresh.repairFacts!);
      const prefix = recoveryActionKey({ incidentId: row.id, subject, causeCode: r.cause.reasonCode, action: spec.action, generation: r.generation, attempt: 0 }).slice(0, -1);
      const used = r.budget.spentKeys.filter(k => k.startsWith(prefix)).length;
      const key = `${prefix}${used + 1}`;
      const recovery: FailureIncidentRecovery = {
        ...r, owner: 'buildd', state: 'recovering', lastSeenAt: now,
        nextAction: { kind: spec.action, label: spec.label, key },
        nextCheckAt: minutesAfter(now, RECOVERY_REPAIR_RECHECK_MINUTES),
        budget: { ...r.budget, spent: r.budget.spent + 1, spentKeys: [...r.budget.spentKeys, key].slice(-MAX_RECOVERY_SPENT_KEYS) },
        attempts: [...r.attempts, { key, action: spec.action, subject, at: now, generation: r.generation }].slice(-MAX_RECOVERY_ATTEMPTS),
      };
      const swapped = await deps.port.compareAndSwap(row.id, row.version, applyIncidentAction(row, { type: 'assess', recovery }, now));
      if (!swapped) {
        const moved = await deps.port.findById(row.id);
        const spent = readRecovery(moved ?? row)?.budget.spentKeys.find(k => k.startsWith(prefix) && !r.budget.spentKeys.includes(k));
        return spent ? { result: 'duplicate', attempt: { actionKey: spent } } : { result: 'stale', detail: 'Another writer changed the incident first.' };
      }
      const peers = fresh.members.filter(m => m.id !== row.id);
      const repairParams = { ...params };
      if (spec.shared && peers.length) {
        // One repair for the cause: it covers every member's subjects (§9.1).
        const ids = (key: 'task' | 'mission') => peers.flatMap(m => readRecovery(m)?.subjects.filter(s => s.kind === key).map(s => s.id) ?? []);
        if (p.repair === 'rerun_visual_audit') {
          repairParams.missionIds = [...new Set([...(repairParams.missionIds as string[] ?? []), ...ids('mission')])];
          repairParams.taskIds = [...new Set([...(repairParams.taskIds as string[] ?? []), ...ids('task')])];
        }
      }
      const ran = await runPlannedRepair(deps.effects, swapped, { key, action: spec.action, subject, params: repairParams });
      if (ran.fixTaskId && deps.effects.linkFixTask) for (const m of peers) await deps.effects.linkFixTask(m.id, ran.fixTaskId).catch(() => {});
      if (deps.events) {
        const event = buildAttemptEvent({ incident: swapped, recovery, repair: { key, action: spec.action, subject }, source: 'click', ok: ran.ok });
        event.detail.actor = actorOf(principal);
        if (spec.shared && peers.length) {
          event.detail.members = { incidentIds: fresh.members.map(m => m.id), subjects: fresh.members.flatMap(m => readRecovery(m)?.subjects ?? []).slice(0, 50) as FailureRecoveryRef[] };
        }
        await deps.events.attempt(event).catch(() => {});
      }
      return { result: 'applied', attempt: { actionKey: key }, ...(ran.ok ? {} : { detail: 'The writer failed; the attempt is recorded and counts toward the budget.' }) };
    }

    case 'retry_recovery':
    case 'decide': {
      const row = incident!;
      const r = readRecovery(row)!;
      if (p.capability === 'decide' && p.option === 'dismiss') {
        const after = await deps.port.compareAndSwap(row.id, row.version, applyIncidentAction(row, { type: 'acknowledge' }, now));
        return after ? { result: 'applied' } : { result: 'stale', detail: 'Another writer changed the incident first.' };
      }
      // A fresh budget for the same generation; the spent keys stay, so no
      // repair key ever runs twice (FIR I-4). An extension raises the limit instead.
      const extend = p.capability === 'retry_recovery' ? p.extendBudgetBy ?? 0 : 0;
      const budget = extend
        ? { ...r.budget, limit: r.budget.limit + extend, extended: (r.budget.extended ?? 0) + extend }
        : { ...r.budget, spent: 0 };
      const decision = r.decision && p.capability === 'decide' ? { ...r.decision, chosen: p.option } : r.decision;
      const reset = await deps.port.compareAndSwap(row.id, row.version, applyIncidentAction(row, { type: 'assess', recovery: { ...r, budget, ...(decision ? { decision } : {}) } }, now));
      if (!reset) return { result: 'stale', detail: 'Another writer changed the incident first.' };
      await deps.reassess(row.id);
      return { result: 'applied' };
    }

    case 'link_fix':
    case 'queue_fix': {
      let taskId = p.capability === 'link_fix' ? fresh.linkTask!.id : null;
      if (p.capability === 'queue_fix') {
        const lead = leadIncidentOf(fresh.members)!;
        taskId = await deps.effects.fileFixTask(lead, `queue_fix:${fresh.causeKey}:${causeRevisionOf(fresh.members)}`);
        if (!taskId) return { result: 'stale', detail: 'Another writer is filing the fix for this cause.' };
      }
      if (deps.effects.linkFixTask) for (const m of fresh.members) await deps.effects.linkFixTask(m.id, taskId!);
      return { result: 'applied', fixTaskId: taskId };
    }

    case 'regroup': {
      const moving = 'mergeInto' in p ? fresh.members : fresh.members.filter(m => p.split.includes(m.id));
      for (const m of moving) {
        const r = readRecovery(m);
        if (!r) continue;
        const rule = ruleCauseKey(m);
        const key = 'mergeInto' in p ? p.mergeInto
          // Split out: its own rule key, or a fresh operator key when the rule key is this cause.
          : rule !== fresh.causeKey ? rule : causeKeyFrom({ family: 'operator', causeCode: 'split', scope: m.id, discriminator: fresh.causeKey ?? '' });
        const causeGroup = { key, source: 'operator' as const, decisionId: opts.auditId ?? null, confidence: null, assignedAt: now, ruleKey: rule };
        const swapped = await deps.port.compareAndSwap(m.id, m.version, applyIncidentAction(m, { type: 'assess', recovery: { ...r, causeGroup } }, now));
        if (!swapped) return { result: 'stale', detail: `Incident ${m.id.slice(0, 8)} changed while regrouping.` };
      }
      return { result: 'applied' };
    }

    case 'set_priority': {
      const teamId = fresh.members.map(m => fresh.teamOf?.(m.workspaceId) ?? null).find((x): x is string => !!x) ?? null;
      if (!teamId) throw new Error('No member team to record the override against.');
      const id = await deps.recordPriority({
        causeKey: fresh.causeKey!, teamId, mode: p.mode, until: p.until, reason: req.reason, by,
        accountId: principal.kind === 'platform_admin' ? principal.accountId : principal.kind === 'team' ? principal.accountId : null,
      });
      if (!id) throw new Error('The override could not be recorded.');
      return { result: 'applied', detail: id };
    }

    case 'pause_automation':
    case 'resume_automation':
    case 'set_policy': {
      const key = automationKeyOf(p, fresh.causeKey)!;
      const expectedRaw = automationRevisionOf(fresh.automation, key);
      const expected = expectedRaw === 'none' ? null : expectedRaw;
      let value: unknown | null;
      let expiresAt: Date | null = null;
      if (p.capability === 'pause_automation') {
        value = { until: p.until, by, reason: req.reason, auditId: opts.auditId ?? null };
        expiresAt = new Date(p.until);
      } else if (p.capability === 'resume_automation') {
        value = null;
      } else {
        const next = applyPolicyPatch(fresh.automation.policy, p.patch);
        if (!next.ok) throw new Error(next.error);
        const { source: _source, ...stored } = next.policy;
        value = stored;
      }
      const written = await deps.writeAutomation({ key, value, expected, expiresAt });
      return written ? { result: 'applied' } : { result: 'stale', detail: 'The switch changed while saving.' };
    }
  }
}

// ── What the read model offers (§8.1: the UI never invents a button) ────────

export interface OfferInput {
  causeKey: string;
  members: StoredIncident[];
  tier: number;
  automation: AutomationState | null;
}

/**
 * Pure. The capabilities valid for this cause on its stored state now. A
 * click still goes through `validateRecoveryAction` on re-read facts; this
 * only decides what is shown. Run-repair offers are limited to the lead (a
 * shared repair runs once) and to repairs that apply to its family.
 */
export function availableActions(input: OfferInput): AvailableAction[] {
  const open = input.members.filter(m => m.status !== 'resolved');
  if (open.length === 0) return [];
  const lead = leadIncidentOf(open)!;
  const r = readRecovery(lead);
  const out: AvailableAction[] = [];
  const causeTarget = { causeKey: input.causeKey };
  const causeEvidence = causeEvidenceRevisionOf(open);
  const incidentTarget = { incidentId: lead.id };
  const ev = r?.observation.evidenceRevision ?? 'none';
  const gen = r?.generation ?? null;

  if (r && r.state !== 'recovered') {
    const exhausted = r.budget.spent >= r.budget.limit;
    if (!exhausted) {
      for (const kind of REPAIR_KINDS) {
        if (kind === 'queue_fix' || !repairAppliesTo(kind, lead.rule)) continue;
        out.push({ capability: 'run_repair', label: REPAIRS[kind].label, target: incidentTarget, generation: gen, evidenceRevision: ev, params: { repair: kind }, effect: `Runs ${REPAIRS[kind].writer} once, after re-checking that it can help.` });
      }
    }
    if (r.state === 'needs_decision' || r.state === 'inconclusive' || r.state === 'needs_operator') {
      out.push({ capability: 'retry_recovery', label: 'Try again', target: incidentTarget, generation: gen, evidenceRevision: ev, effect: 'Buildd re-reads the facts and repairs what it can, with a fresh budget.' });
      if (exhausted && (r.budget.extended ?? 0) < MAX_BUDGET_EXTENSIONS) {
        out.push({ capability: 'retry_recovery', label: 'Allow one more repair', target: incidentTarget, generation: gen, evidenceRevision: ev, params: { extendBudgetBy: 1 }, effect: 'Raises this occurrence\'s repair budget by one.' });
      }
    }
    if (r.state === 'needs_decision') {
      for (const o of r.decision?.options ?? []) {
        if (!APPLIED_DECISION_OPTIONS.has(o.capability)) continue;
        out.push({ capability: 'decide', label: o.label, target: incidentTarget, generation: gen, evidenceRevision: ev, params: { option: o.capability }, effect: o.effect });
      }
    }
  }
  const fixLive = open.some(m => !!m.linkedFixTaskId);
  const platformDefect = open.some(m => causeScope(m) === 'platform' || readRecovery(m)?.cause.ownership === 'infrastructure');
  if (!fixLive) {
    if (platformDefect) out.push({ capability: 'queue_fix', label: 'Queue a fix', target: causeTarget, generation: null, evidenceRevision: causeEvidence, effect: 'Files one fix task for the cause and links every incident to it.' });
    out.push({ capability: 'link_fix', label: 'Link an existing fix', target: causeTarget, generation: null, evidenceRevision: causeEvidence, effect: 'Links a task or PR as the fix for every incident in the cause.' });
  }
  out.push({ capability: 'regroup', label: 'Regroup', target: causeTarget, generation: null, evidenceRevision: causeEvidence, effect: 'Merges this problem into another, or splits incidents out of it.' });
  out.push({ capability: 'set_priority', label: 'Change priority', target: causeTarget, generation: null, evidenceRevision: causeEvidence, params: { maxHours: input.tier === 0 ? 24 : 168 }, effect: 'Pins, demotes or snoozes this problem within its tier. Customers see no change.' });
  const pauseCauseKey = pauseKey({ kind: 'cause', causeKey: input.causeKey });
  const paused = !!input.automation?.pauses[pauseCauseKey];
  const pauseRevision = input.automation ? automationRevisionOf(input.automation, pauseCauseKey) : 'none';
  out.push(paused
    ? { capability: 'resume_automation', label: 'Resume automatic repair', target: causeTarget, generation: null, evidenceRevision: pauseRevision, params: { scope: 'cause' }, effect: 'Buildd repairs this problem on its own again.' }
    : { capability: 'pause_automation', label: 'Pause automatic repair', target: causeTarget, generation: null, evidenceRevision: pauseRevision, params: { scope: 'cause' }, effect: 'Buildd keeps checking but runs no repair for this problem until you resume it (at most 7 days).' });
  return out;
}

/** §7.2: the audit's before/after view of a cause row, minus the task sample. */
export function auditView<T extends { impact?: { tasks?: { count: number; sample?: unknown } } }>(row: T | null): Record<string, unknown> | null {
  if (!row) return null;
  const { impact, ...rest } = row as T & { impact?: Record<string, unknown> };
  if (!impact) return rest as Record<string, unknown>;
  const tasks = (impact as { tasks?: { count: number } }).tasks;
  return { ...rest, impact: { ...impact, tasks: tasks ? { count: tasks.count } : undefined } };
}
