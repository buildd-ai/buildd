/**
 * The operator-recovery decision pass: once per full Failure Pattern Sentinel
 * sweep, ask the three operator-recovery kinds what the rules could not settle,
 * apply what may be applied, label earlier answers, and switch a kind off when
 * its readout crosses the §6.5 line (operator-recovery spec §6).
 *
 *  - Merge: the ambiguous cause pairs (`ambiguousCausePairs`).
 *  - Repair: stuck causes no approved runbook owns, with some repair valid now.
 *  - Priority advice: the top of the queue (tiers 0 to 2), shown beside the
 *    baseline position, never applied.
 *
 * Questions per pass are capped; the daily caps, breaker and per-call deadline
 * live in `runOperatorRecoveryDecision`. Every answer is cached on its
 * evidence revision, so an unchanged cause is not asked again.
 *
 * Never throws.
 */
import {
  OPERATOR_CAUSE_MERGE_KIND, OPERATOR_PRIORITY_ADVICE_KIND, OPERATOR_REPAIR_SUGGESTION_KIND,
} from '@buildd/core/decision-kind-operator-recovery';
import type { RecoveryCauseRow } from '@buildd/shared';
import { effectiveCauseKey } from './failure-incident-cause-key';
import { causeEvidenceRevisionOf, type RecoveryActionDeps } from './failure-incident-recovery-actions';
import { buildAutomationState, type AutomationState } from './failure-incident-recovery-automation';
import { leadIncidentOf, type RepairFacts } from './failure-incident-repairs';
import type { IncidentStorePort, StoredIncident } from './failure-incident-store';
import { buildRecoveryPanel, type QueueFacts } from './admin/recovery/queue';
import {
  ambiguousCausePairs, applyCauseMerge, applyRepairSuggestion, pairSameTeam, pairSubjectId, repairQuestionFor, validRepairCapabilities,
  type CauseView,
} from './operator-recovery-decision-apply';
import { buildOperatorEvidencePack, type PackCauseInput, type PackNames } from './operator-recovery-evidence';
import { runOperatorRecoveryDecision, type OperatorDecisionDeps } from './operator-recovery-decisions';

/** Model questions per pass, across the three kinds. The daily caps still apply. */
export const MAX_QUESTIONS_PER_PASS = 12;
/** Priority advice is asked for the top of the queue only. */
export const MAX_PRIORITY_QUESTIONS = 8;

export interface OperatorPassDeps {
  now(): Date;
  /** The platform-wide queue facts (`loadRecoveryFacts`). */
  loadFacts(): Promise<QueueFacts>;
  decision: OperatorDecisionDeps;
  port: Pick<IncidentStorePort, 'findById' | 'compareAndSwap'>;
  /** The owner action service's deps, shared by a model's repair (§8.2). */
  actionDeps(): Promise<RecoveryActionDeps>;
  repairFacts(lead: StoredIncident, peers: StoredIncident[]): Promise<RepairFacts | null>;
  /** Raw excerpts for a cause's members (worker errors, evidence notes), newest first. Redacted by the pack. */
  excerpts(members: StoredIncident[]): Promise<Array<{ ref: string; text: string }>>;
  /** Label earlier answers' outcomes. Returns labels written. */
  labelOutcomes?(): Promise<number>;
  /** Evaluate each kind's readout against the switch-off line. */
  evaluateHealth?(): Promise<void>;
}

export interface OperatorPassResult {
  asked: number;
  merged: number;
  repaired: number;
  suggested: number;
  advised: number;
  labelled: number;
}

interface CauseEntry {
  row: RecoveryCauseRow;
  view: CauseView;
  lead: StoredIncident;
}

function namesOf(facts: QueueFacts): PackNames {
  return {
    teams: [...facts.teams.values()].map(t => t.name),
    workspaces: [...facts.workspaces.values()].map(w => w.name),
    tasks: [...(facts.tasks?.values() ?? [])].map(t => t.title).concat([...facts.missions.values()].map(m => m.title)),
  };
}

function packInput(e: CauseEntry, facts: QueueFacts, excerpts: Array<{ ref: string; text: string }>): PackCauseInput {
  const ids = new Set(e.view.members.map(m => m.id));
  const attempts = (facts.attempts ?? [])
    .filter(a => ids.has(a.detail.incidentId) || a.detail.causeKey === e.row.causeKey)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))
    .map(a => ({ actionKey: a.detail.actionKey, capability: a.detail.capability, outcome: a.detail.verify?.passed === true ? 'progressed' : a.detail.verify?.passed === false ? 'no_effect' : a.outcome }));
  return {
    causeKey: e.row.causeKey,
    members: e.view.members,
    tier: e.row.rank.tier,
    state: e.row.state,
    counts: {
      teams: e.row.impact.teams.length, workspaces: e.row.impact.workspaces.length, missions: e.row.impact.missions.length,
      tasks: e.row.impact.tasks.count, blockedNow: e.row.impact.blockedNow, episodes24h: e.row.trend.episodes24h, reopens7d: e.row.trend.reopens7d,
    },
    oldestOpenAgeH: e.row.timing.oldestOpenAgeH,
    lastProgressAt: e.row.timing.lastProgressAt,
    attempts,
    excerpts,
  };
}

export async function runOperatorRecoveryPass(deps: OperatorPassDeps): Promise<OperatorPassResult> {
  const out: OperatorPassResult = { asked: 0, merged: 0, repaired: 0, suggested: 0, advised: 0, labelled: 0 };
  try {
    const facts = await deps.loadFacts();
    const panel = buildRecoveryPanel(facts);
    const now = deps.now();
    const teamOf = (ws: string | null) => (ws ? facts.workspaces.get(ws)?.teamId ?? null : null);
    const byKey = new Map<string, StoredIncident[]>();
    for (const i of facts.incidents) {
      if (i.status === 'resolved') continue;
      const key = effectiveCauseKey(i).key;
      byKey.set(key, [...(byKey.get(key) ?? []), i]);
    }
    const entries: CauseEntry[] = [];
    for (const row of panel.causes) {
      const members = byKey.get(row.causeKey) ?? [];
      const lead = leadIncidentOf(members);
      if (!lead) continue;
      entries.push({ row, lead, view: { causeKey: row.causeKey, members, teamIds: members.map(m => teamOf(m.workspaceId)) } });
    }
    const names = namesOf(facts);
    const teamFor = (ms: StoredIncident[]) => ms.map(m => ({ teamId: teamOf(m.workspaceId), workspaceId: m.workspaceId })).find(x => !!x.teamId) ?? null;
    const excerptCache = new Map<string, Array<{ ref: string; text: string }>>();
    const excerptsFor = async (e: CauseEntry) => {
      if (!excerptCache.has(e.row.causeKey)) excerptCache.set(e.row.causeKey, await deps.excerpts(e.view.members).catch(() => []));
      return excerptCache.get(e.row.causeKey)!;
    };
    const budgetLeft = () => out.asked < MAX_QUESTIONS_PER_PASS;
    const counted = (r: { source: string }) => { if (r.source !== 'skipped' && r.source !== 'cache') out.asked++; };

    // ── Merge ──
    const byCause = new Map(entries.map(e => [e.row.causeKey, e]));
    for (const [a, b] of ambiguousCausePairs(entries.map(e => e.view))) {
      if (!budgetLeft()) break;
      const ea = byCause.get(a.causeKey)!, eb = byCause.get(b.causeKey)!;
      const team = teamFor([...a.members, ...b.members]);
      if (!team) continue;
      const built = buildOperatorEvidencePack(
        [packInput(ea, facts, (await excerptsFor(ea)).slice(0, 2)), packInput(eb, facts, (await excerptsFor(eb)).slice(0, 2))],
        { names, now: now.toISOString() },
      );
      const result = await runOperatorRecoveryDecision({
        kind: OPERATOR_CAUSE_MERGE_KIND, subjectId: pairSubjectId(a.causeKey, b.causeKey),
        evidenceRevision: [causeEvidenceRevisionOf(a.members), causeEvidenceRevisionOf(b.members)].sort().join('+'),
        features: { pack: built.pack, sameTeam: pairSameTeam(a, b) }, refs: built.refs, teamId: team.teamId!, workspaceId: team.workspaceId,
      }, deps.decision);
      counted(result);
      const applied = await applyCauseMerge(result, [a, b], { port: deps.port, now: () => deps.now().toISOString() });
      if (applied.merged) out.merged++;
    }

    // ── Repair ──
    let automation: AutomationState | null = null;
    let actionDeps: RecoveryActionDeps | null = null;
    for (const e of entries) {
      if (!budgetLeft()) break;
      if (!repairQuestionFor(e.lead)) continue;
      const team = teamFor([e.lead, ...e.view.members]);
      if (!team) continue;
      const peers = e.view.members.filter(m => m.id !== e.lead.id);
      const repairFacts = await deps.repairFacts(e.lead, peers).catch(() => null);
      const valid = validRepairCapabilities(e.lead, repairFacts);
      if (valid.length === 0) continue;
      const built = buildOperatorEvidencePack([packInput(e, facts, await excerptsFor(e))], { names, now: now.toISOString() });
      const result = await runOperatorRecoveryDecision({
        kind: OPERATOR_REPAIR_SUGGESTION_KIND, subjectId: e.row.causeKey, evidenceRevision: causeEvidenceRevisionOf(e.view.members),
        features: { pack: built.pack, validCapabilities: valid }, refs: built.refs, teamId: team.teamId!, workspaceId: team.workspaceId,
      }, deps.decision);
      counted(result);
      if (result.source === 'skipped' || result.answer === 'none' || result.answer === 'escalate') continue;
      automation ??= facts.automationState ?? buildAutomationState(null, now);
      actionDeps ??= await deps.actionDeps();
      const ran = await applyRepairSuggestion(result, {
        lead: e.lead, members: e.view.members, causeKey: e.row.causeKey, automation, repairFacts, tier: e.row.rank.tier, now: now.toISOString(),
      }, actionDeps);
      if (ran.executed) out.repaired++;
      else out.suggested++;
    }

    // ── Priority advice ──
    for (const e of entries.filter(x => x.row.rank.tier <= 2).slice(0, MAX_PRIORITY_QUESTIONS)) {
      if (!budgetLeft()) break;
      const team = teamFor(e.view.members);
      if (!team) continue;
      const built = buildOperatorEvidencePack([packInput(e, facts, await excerptsFor(e))], { names, now: now.toISOString() });
      const result = await runOperatorRecoveryDecision({
        kind: OPERATOR_PRIORITY_ADVICE_KIND, subjectId: e.row.causeKey, evidenceRevision: causeEvidenceRevisionOf(e.view.members),
        features: { pack: built.pack, tier: e.row.rank.tier, position: e.row.rank.position, score: e.row.rank.score },
        refs: built.refs, teamId: team.teamId!, workspaceId: team.workspaceId,
      }, deps.decision);
      counted(result);
      if (result.source === 'model') out.advised++;
    }

    out.labelled = await (deps.labelOutcomes?.() ?? Promise.resolve(0)).catch(() => 0);
    await deps.evaluateHealth?.().catch(err => console.warn('[operator-recovery] kind health check failed:', err instanceof Error ? err.message : err));
  } catch (err) {
    console.error('[operator-recovery] decision pass failed (non-fatal):', err instanceof Error ? err.message : err);
  }
  return out;
}
