/**
 * What an operator-recovery decision does once answered (operator-recovery
 * spec §4.2, §6.2, §6.5, §6.6), and how each answer is later labelled.
 *
 *  - **When to ask.** `ambiguousCausePairs` picks the cause pairs the rule key
 *    leaves ambiguous; `repairQuestionFor` asks for a repair only when no
 *    approved runbook matches and some repair is valid now.
 *  - **Merge** (`applyCauseMerge`): a `merge` answer moves the younger cause's
 *    members onto the older cause's key with `causeGroup.source = 'model'`,
 *    through the incident CAS. It never splits a rule key, never touches a
 *    member an operator regrouped (the operator always wins), and re-checks
 *    the cross-team rule itself. `separate`, `unsure` and every fallback
 *    leave both causes as they are.
 *  - **Repair** (`applyRepairSuggestion`): the answer is re-validated exactly
 *    as an owner click is (`validateRecoveryAction`, principal `model`), so it
 *    runs only inside `validCapabilities ∩ AUTO_ELIGIBLE` and only when the
 *    precondition, budget and pause allow. Anything else stays a suggestion
 *    shown to the owner; it is never executed.
 *  - **Priority advice** is never applied (shown beside the baseline position).
 *  - **Outcomes** (`*OutcomeLabel`): merge from an operator regroup (or its
 *    absence after a week), repair from the attempt's own verify predicate,
 *    priority from whether the owner acted on the cause within 24 hours.
 *
 * Pure, except the two appliers, which only touch their injected deps.
 */
import type { FailureRecoveryCauseGroup } from '@buildd/shared';
import {
  OPERATOR_REPAIR_KINDS, type OperatorRepairKind,
} from '@buildd/core/decision-kind-operator-recovery';
import { causeCodeOf, causeDiscriminator, causeScope, ruleCauseKey } from './failure-incident-cause-key';
import { readRecovery } from './failure-incident-recovery';
import {
  applyIncidentRecoveryAction, validateRecoveryAction,
  type AdminRecoveryActionRequest, type RecoveryActionDeps, type RecoveryFresh, type RecoveryValidation,
} from './failure-incident-recovery-actions';
import type { AutomationState } from './failure-incident-recovery-automation';
import { REPAIR_KINDS } from './failure-incident-recovery-events';
import { checkRepair, leadIncidentOf, REPAIRS, repairAppliesTo, runbookFor, type RepairFacts } from './failure-incident-repairs';
import { applyIncidentAction, type IncidentStorePort, type StoredIncident } from './failure-incident-store';
import type { OperatorDecisionResult } from './operator-recovery-decisions';

// ── When to ask ─────────────────────────────────────────────────────────────

export interface CauseView {
  causeKey: string;
  members: StoredIncident[];
  /** The team of each member's workspace (null: platform-scoped or unknown). */
  teamIds: ReadonlyArray<string | null>;
}

/** At most this many pairs per pass: a merge is rare, and each one is a call. */
export const MAX_MERGE_PAIRS = 5;

const open = (c: CauseView) => c.members.filter(m => m.status !== 'resolved');
const isWorkspaceCause = (c: CauseView) => c.members.every(m => causeScope(m) !== 'platform');
const teamSet = (c: CauseView) => new Set(c.teamIds);
const sameTeams = (a: CauseView, b: CauseView) => {
  const x = teamSet(a), y = teamSet(b);
  return x.size === y.size && [...x].every(t => y.has(t));
};
/** One team behind every member of both causes. */
export const pairSameTeam = (a: CauseView, b: CauseView) => sameTeams(a, b) && teamSet(a).size === 1 && !teamSet(a).has(null);

/**
 * Pairs of open causes the rule key leaves ambiguous: same family, and either
 * the same cause code under a different scope or discriminator, or the same
 * discriminator under a different cause code. Never a pair the operator has
 * grouped by hand, and never a pair the cross-team rule already refuses.
 */
export function ambiguousCausePairs(causes: readonly CauseView[]): Array<[CauseView, CauseView]> {
  const live = causes.filter(c => open(c).length > 0 && !c.members.some(m => readRecovery(m)?.causeGroup?.source === 'operator'));
  const pairs: Array<[CauseView, CauseView]> = [];
  for (let i = 0; i < live.length && pairs.length < MAX_MERGE_PAIRS; i++) {
    for (let j = i + 1; j < live.length && pairs.length < MAX_MERGE_PAIRS; j++) {
      const [a, b] = [live[i], live[j]].sort((x, y) => x.causeKey.localeCompare(y.causeKey));
      const la = leadIncidentOf(open(a))!, lb = leadIncidentOf(open(b))!;
      if (la.rule !== lb.rule) continue;
      const sameCode = causeCodeOf(la) === causeCodeOf(lb);
      const sameDisc = causeDiscriminator(la.rule, la.signature, la.impact) === causeDiscriminator(lb.rule, lb.signature, lb.impact);
      if (!sameCode && !sameDisc) continue;
      if (isWorkspaceCause(a) && isWorkspaceCause(b) && !pairSameTeam(a, b)) continue;
      pairs.push([a, b]);
    }
  }
  return pairs;
}

/** The merge question's subject: both keys, sorted. */
export const pairSubjectId = (a: string, b: string) => [a, b].sort().join('+');

/** Repairs valid for this lead on fresh facts: allowlisted for its family and their precondition holds now. */
export function validRepairCapabilities(lead: Pick<StoredIncident, 'rule'>, facts: RepairFacts | null): OperatorRepairKind[] {
  if (!facts) return [];
  return REPAIR_KINDS.filter(k => repairAppliesTo(k, lead.rule) && checkRepair(k, facts) === null) as OperatorRepairKind[];
}

const NEEDS_REPAIR_ADVICE: ReadonlySet<string> = new Set(['needs_decision', 'needs_operator', 'inconclusive']);

/**
 * Ask for a repair only when the cause is stuck and no approved runbook owns
 * it (§6.1 b, §9.3): path overlap has FIR's own rules, two families have
 * B2's runbooks.
 */
export function repairQuestionFor(lead: StoredIncident): boolean {
  const r = readRecovery(lead);
  if (!r || lead.status === 'resolved' || !NEEDS_REPAIR_ADVICE.has(r.state)) return false;
  if (lead.rule === 'path_overlap_stall') return false;
  return runbookFor({ rule: lead.rule, signature: lead.signature, reasonCode: lead.reasonCode, causeCode: r.cause.reasonCode }) === null;
}

// ── Merge ───────────────────────────────────────────────────────────────────

export type MergeApplied =
  | { merged: true; into: string; moved: string[] }
  | { merged: false; reason: 'not_merge' | 'not_applied' | 'cross_team' | 'stale' | 'nothing_to_move' };

const firstSeen = (c: CauseView) => Math.min(...c.members.map(m => Date.parse(readRecovery(m)?.firstSeenAt ?? m.firstSeenAt)));

/**
 * Apply a `merge` answer: the younger cause joins the older one. Each member
 * is re-read and written through the CAS on its own version; a member that
 * moved, resolved or was regrouped by an operator is left alone.
 */
export async function applyCauseMerge(
  result: OperatorDecisionResult,
  pair: [CauseView, CauseView],
  deps: { port: Pick<IncidentStorePort, 'findById' | 'compareAndSwap'>; now(): string },
): Promise<MergeApplied> {
  if (result.source === 'skipped' || result.answer !== 'merge') return { merged: false, reason: 'not_merge' };
  if (!result.applied || (result.source !== 'model' && result.source !== 'cache')) return { merged: false, reason: 'not_applied' };
  const [a, b] = pair;
  if (isWorkspaceCause(a) && isWorkspaceCause(b) && !pairSameTeam(a, b)) return { merged: false, reason: 'cross_team' };
  const [survivor, moving] = firstSeen(a) < firstSeen(b) || (firstSeen(a) === firstSeen(b) && a.causeKey < b.causeKey) ? [a, b] : [b, a];
  const now = deps.now();
  const moved: string[] = [];
  for (const m of moving.members) {
    const fresh = await deps.port.findById(m.id);
    const r = fresh ? readRecovery(fresh) : null;
    if (!fresh || !r || fresh.status === 'resolved') continue;
    if (r.causeGroup?.source === 'operator') continue;
    if (r.causeGroup?.key === survivor.causeKey) continue;
    const causeGroup: FailureRecoveryCauseGroup = {
      key: survivor.causeKey, source: 'model', decisionId: result.decisionId, confidence: result.confidence,
      assignedAt: now, ruleKey: ruleCauseKey(fresh),
    };
    const swapped = await deps.port.compareAndSwap(fresh.id, fresh.version, applyIncidentAction(fresh, { type: 'assess', recovery: { ...r, causeGroup } }, now));
    if (swapped) moved.push(fresh.id);
  }
  if (moved.length === 0) return { merged: false, reason: moving.members.length ? 'stale' : 'nothing_to_move' };
  return { merged: true, into: survivor.causeKey, moved };
}

// ── Repair ──────────────────────────────────────────────────────────────────

export type RepairApplied =
  | { executed: true; repair: OperatorRepairKind; actionKey: string | null }
  /** Shown to the owner as a suggestion; not run. */
  | { executed: false; repair: OperatorRepairKind | null; reason: 'no_repair' | 'not_applied' | RecoveryValidation['result'] | 'stale' | 'duplicate'; detail?: string };

export interface RepairContext {
  lead: StoredIncident;
  members: StoredIncident[];
  causeKey: string;
  automation: AutomationState;
  repairFacts: RepairFacts | null;
  tier: number | null;
  now: string;
}

const isRepairKind = (s: string): s is OperatorRepairKind => (OPERATOR_REPAIR_KINDS as readonly string[]).includes(s);

/**
 * Run a suggested repair only as an owner click would run: the shared
 * validator on fresh facts, with the model principal (§6.6). A repair outside
 * AUTO_ELIGIBLE is refused by that validator, at any confidence.
 */
export async function applyRepairSuggestion(result: OperatorDecisionResult, ctx: RepairContext, deps: RecoveryActionDeps): Promise<RepairApplied> {
  if (result.source === 'skipped' || !isRepairKind(result.answer)) return { executed: false, repair: null, reason: 'no_repair' };
  const repair = result.answer;
  if (!result.applied || !result.decisionId || (result.source !== 'model' && result.source !== 'cache')) return { executed: false, repair, reason: 'not_applied' };
  const r = readRecovery(ctx.lead);
  if (!r) return { executed: false, repair, reason: 'precondition', detail: 'The incident has no assessment.' };
  const principal = { kind: 'model' as const, decisionId: result.decisionId, promoted: true };
  const req: AdminRecoveryActionRequest = {
    capability: 'run_repair',
    target: { incidentId: ctx.lead.id, generation: r.generation },
    evidenceRevision: r.observation.evidenceRevision,
    params: { capability: 'run_repair', repair },
    reason: `Model suggestion (decision ${result.decisionId.slice(0, 8)})`,
  };
  const fresh: RecoveryFresh = {
    now: ctx.now, incident: ctx.lead, members: ctx.members, causeKey: ctx.causeKey,
    automation: ctx.automation, repairFacts: ctx.repairFacts, tier: ctx.tier,
  };
  const v = validateRecoveryAction(principal, req, fresh);
  if (v.result !== 'ok') return { executed: false, repair, reason: v.result, detail: v.detail };
  if (!REPAIRS[repair].autoEligible) return { executed: false, repair, reason: 'not_supported' };
  const ran = await applyIncidentRecoveryAction(deps, principal, req, fresh);
  if (ran.result === 'applied') return { executed: true, repair, actionKey: ran.attempt?.actionKey ?? null };
  return { executed: false, repair, reason: ran.result, ...(ran.result === 'stale' ? { detail: ran.detail } : {}) };
}

// ── Outcome labels (§6.5) ───────────────────────────────────────────────────

const DAY = 86_400_000;
export const MERGE_ACCEPT_AFTER_MS = 7 * DAY;
export const PRIORITY_ACT_WINDOW_MS = DAY;

/** A merge stood a week without an operator regroup of either cause: accepted. A regroup after it: regrouped. */
export function mergeOutcomeLabel(decidedAt: string, regroupsAt: readonly string[], now: string): 'accepted' | 'regrouped' | null {
  if (regroupsAt.some(t => t > decidedAt)) return 'regrouped';
  return Date.parse(now) - Date.parse(decidedAt) >= MERGE_ACCEPT_AFTER_MS ? 'accepted' : null;
}

/** The suggested repair's attempt: its own verify verdict (§9.4). Writer accepted is never success. */
export function repairOutcomeLabel(attempt: { outcome: string; verifyPassed: boolean | null }): 'progressed' | 'no_effect' | 'failed' | null {
  if (attempt.outcome === 'rejected') return 'failed';
  if (attempt.verifyPassed === true) return 'progressed';
  if (attempt.verifyPassed === false) return 'no_effect';
  return null;
}

/** Advice is `acted` on when the owner took any recovery action on the cause within 24 h. */
export function priorityOutcomeLabel(advisedAt: string, ownerActionsAt: readonly string[], now: string): 'acted' | 'not_acted' | null {
  const end = Date.parse(advisedAt) + PRIORITY_ACT_WINDOW_MS;
  if (ownerActionsAt.some(t => t >= advisedAt && Date.parse(t) <= end)) return 'acted';
  return Date.parse(now) >= end ? 'not_acted' : null;
}
