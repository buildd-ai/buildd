/**
 * The Failure Pattern Sentinel's pages, through the escalation gate.
 *
 * An incident is a gate subject (`incident:<id>`). The same order as a PR:
 * rules first, Jev only on a concern, one owner, and the verdict is stored in
 * the decision ledger so every surface reads the same answer instead of
 * deciding again.
 *
 *  - a critical platform incident is the owner's, by rule, even with a fix
 *    task running: they are told once;
 *  - any other incident whose fix task is still open is Buildd's: no ping;
 *  - a path-overlap stall is Buildd's: the task waits for an overlapping PR,
 *    the claim loop wakes it when the paths free up and the sweep resolves the
 *    incident once it moves. A decision on the blocking PR is that PR's own
 *    card, so this one never asks the owner for nothing;
 *  - a high incident nothing is fixing has no next step of its own: the owner,
 *    unless the optional `judge` (Jev) hands it to Buildd;
 *  - medium, low and resolved incidents are Buildd's and never page.
 *
 * One ping per transition: the verdict is filed under a fingerprint of the
 * state it was made on (severity, status, recurrences, scope tier, fix task
 * running). A replay of the same state reuses the stored verdict and does not
 * ping again; a worse severity, a recurrence, a wider scope or a fix task
 * ending is a new look. Never silences: a failed read pages, and an owner
 * verdict is stored only after the page went out, so a failed page is tried
 * again on the next replay instead of being remembered as sent.
 *
 * Home, the Needs You badge and the push read the same stored row and draw
 * their words from one projection (`projectIncident` in lib/incident-view.ts):
 * the push is sent at the moment the verdict is made, and Home lists every
 * unresolved incident the projection says needs the owner
 * (`incidentNeedsYouItems`), with no model call on the page path. The verdict
 * row carries the assessment generation it was made on (`@g<n>` on its
 * `reason`), so a verdict from an older generation is read as absent.
 *
 * Jev: the `judge` slot is where a concern no rule answers would go (a high
 * incident nothing is fixing). It is not wired yet: the Sentinel files a fix
 * task before paging whenever it can, so a high incident with no fix task has
 * no machine step for Jev to hand it to, and it goes to the owner by rule.
 * A judged row files the judge's answer as its verdict, the rule's as
 * `ruleAnswer`, and keeps what the judge was asked as a replayable copy.
 */
import { createHash } from 'node:crypto';
import {
  ESCALATION_GATE_CAPABILITY,
  ESCALATION_GATE_PROMPT_VERSION,
  verdictCode,
  verdictFromCode,
  type EscalationVerdict,
} from '@buildd/core/escalation-gate';
import type { DecisionLedgerInput } from '@buildd/core/decision-ledger';
import type { DecisionReplayCapture } from '@buildd/core/decision-replay';
import type {
  FailureIncidentRecovery,
  FailureIncidentRule,
  FailureIncidentSeverity,
  FailureIncidentStatus,
  FailureRecoveryOwner,
  FailureRecoveryState,
} from '@buildd/shared';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import type { WaitingOnYouRawItem } from './action-queue';
import { BUILDD_RECOVERED_RULES, projectIncident, type IncidentForView, type IncidentVerdictView } from './incident-view';
import {
  formatIncidentAlert,
  impactScope,
  incidentDeepLink,
  scopeTier,
  type IncidentAlert,
  type IncidentAlertSender,
} from './failure-incident-actions';

export const INCIDENT_SUBJECT_TYPE = 'incident';

export interface IncidentSubject {
  /** `incident:<id>`. */
  key: string;
  incidentId: string;
  teamId: string;
  workspaceId: string | null;
  severity: FailureIncidentSeverity;
  status: FailureIncidentStatus;
  /** The sentinel rule that opened it. Not part of the fingerprint. */
  rule?: FailureIncidentRule;
  /** The linked fix task; `running` is true while it is not finished. */
  fixTask: { id: string; running: boolean } | null;
  recurrenceCount: number;
  /** `impactScope` of the incident. */
  scope: number;
  /**
   * The recovery assessment, when there is one (failure-incident-recovery §4).
   * It decides the owner below critical, and its generation and state are
   * part of the fingerprint, so a new assessment is a new look.
   */
  recovery?: IncidentSubjectRecovery | null;
}

export interface IncidentSubjectRecovery {
  generation: number;
  state: FailureRecoveryState;
  owner: FailureRecoveryOwner;
  /** The assessment's own sentence: its question, its gap, or what Buildd is doing. */
  reason: string;
  nextCheckAt: string | null;
}

/** The gate's view of a stored assessment. Null when not assessed. */
export function incidentSubjectRecovery(r: FailureIncidentRecovery | null | undefined): IncidentSubjectRecovery | null {
  if (!r || r.v !== 1) return null;
  const reason = r.state === 'needs_decision' && r.decision ? r.decision.question
    : r.state === 'needs_operator' && r.capabilityGap ? `Needs an operator: ${r.capabilityGap.reason}`
      : r.nextAction?.label ?? 'Buildd is checking this incident.';
  return { generation: r.generation, state: r.state, owner: r.owner, reason, nextCheckAt: r.nextCheckAt };
}

export const incidentSubjectKey = (incidentId: string) => `${INCIDENT_SUBJECT_TYPE}:${incidentId}`;

/**
 * Rules whose incidents below critical are Buildd's whatever is linked: the
 * platform owns the recovery and the human decision, if any, has its own card.
 */
const BUILDD_RECOVERS: ReadonlySet<FailureIncidentRule> = BUILDD_RECOVERED_RULES;

const PATH_OVERLAP_WAIT =
  'A task is waiting for an overlapping change to land. Buildd wakes it when the paths free up and resolves this once it moves; a decision on the blocking PR shows on that PR.';

/** failure-incident-recovery §16.2/§18.4: Buildd's own machinery failed; no workspace person's decision fixes it. */
const INFRASTRUCTURE_WAIT =
  "Buildd's own machinery failed for these tasks. Buildd retries them and tells the operator if it cannot recover; nothing here needs your decision.";

/** Pure. The deterministic verdict for an incident. */
export function incidentEscalationRule(s: IncidentSubject): EscalationVerdict {
  if (s.status === 'resolved') return { owner: 'buildd', by: 'rule', action: 'hold', reason: 'Resolved, nothing to do.' };
  if (s.severity === 'critical') {
    return { owner: 'person', by: 'rule', rail: 'critical_incident', reason: 'A critical platform incident: the owner is told once, whatever else is running.' };
  }
  if (s.recovery) return recoveryVerdict(s.status, s.recovery);
  if (s.rule && BUILDD_RECOVERS.has(s.rule)) {
    return { owner: 'buildd', by: 'rule', action: 'hold', reason: s.rule === 'infrastructure_failure' ? INFRASTRUCTURE_WAIT : PATH_OVERLAP_WAIT };
  }
  if (s.fixTask?.running) {
    return { owner: 'buildd', by: 'rule', action: 'wait_machine', reason: `Buildd is fixing it (task ${s.fixTask.id.slice(0, 8)}).` };
  }
  if (s.severity === 'high') {
    return { owner: 'person', by: 'rule', rail: 'no_next_step', reason: 'Automatic recovery unavailable: Buildd has no recovery policy or running fix for this incident, so it comes to you.' };
  }
  return { owner: 'buildd', by: 'rule', action: 'hold', reason: 'Below the paging line; it stays on the incident page.' };
}

/**
 * Below critical, an assessed incident's owner is its assessment's (§4):
 * only `needs_decision` reaches a person; a dismissal is not paged again; an
 * operator-owned gap is held off the workspace owner's inbox.
 */
function recoveryVerdict(status: FailureIncidentStatus, r: IncidentSubjectRecovery): EscalationVerdict {
  if (status === 'acknowledged') return { owner: 'buildd', by: 'rule', action: 'hold', reason: 'Dismissed; Buildd keeps checking it.' };
  switch (r.state) {
    case 'needs_decision':
      return { owner: 'person', by: 'rule', rail: 'no_next_step', reason: r.reason };
    case 'recovering':
      return { owner: 'buildd', by: 'rule', action: 'wait_machine', reason: r.reason };
    case 'recovered':
      return { owner: 'buildd', by: 'rule', action: 'hold', reason: 'Resolved, nothing to do.' };
    default:
      return { owner: 'buildd', by: 'rule', action: 'hold', reason: r.reason, ...(r.nextCheckAt ? { holdUntil: r.nextCheckAt } : {}) };
  }
}

/** A hash of the state a verdict was made on. Occurrence counts are not state. */
export function incidentFingerprint(s: IncidentSubject): string {
  const state = {
    v: ESCALATION_GATE_PROMPT_VERSION, key: s.key, severity: s.severity, status: s.status,
    recurrence: s.recurrenceCount, tier: scopeTier(s.scope), fix: s.fixTask ? { id: s.fixTask.id, running: s.fixTask.running } : null,
    // Only when assessed, so an unassessed incident keeps its stored fingerprint.
    ...(s.recovery ? { recovery: { g: s.recovery.generation, state: s.recovery.state } } : {}),
  };
  return createHash('sha256').update(JSON.stringify(state)).digest('hex').slice(0, 16);
}

export interface IncidentGateDeps {
  /** workspace → owning team; null: no owner, so record only. */
  loadTeamId: (workspaceId: string) => Promise<string | null>;
  loadFixTask: (taskId: string) => Promise<{ id: string; status: string } | null>;
  /** The newest stored verdict for the incident, or null. */
  loadStored: (teamId: string, key: string) => Promise<{ fingerprint: string; appliedAnswer: string | null } | null>;
  record: (input: DecisionLedgerInput) => Promise<string | null | void>;
  notify: (teamId: string, payload: { title: string; message: string; url: string; urlTitle: string; priority: 0 | 1 }) => Promise<void>;
  /** Jev, asked only for a concern no rule answers (a high incident nothing is fixing). Absent: the owner. */
  judge?: (s: IncidentSubject) => Promise<IncidentJudgement | null>;
}

/**
 * The judge's answer, and what it was asked (`@buildd/core/decision-replay`):
 * the row filed for it keeps that as a replayable copy.
 */
export interface IncidentJudgement {
  verdict: EscalationVerdict;
  replay?: DecisionReplayCapture | null;
}

async function subjectFor(a: IncidentAlert, teamId: string, deps: IncidentGateDeps): Promise<IncidentSubject> {
  const inc = a.incident!;
  let fixTask: IncidentSubject['fixTask'] = null;
  if (inc.linkedFixTaskId) {
    // A task that cannot be read is unknown, not finished: it keeps the page.
    const t = await deps.loadFixTask(inc.linkedFixTaskId).catch(() => null);
    if (t) fixTask = { id: t.id, running: !(TERMINAL_TASK_STATUSES as readonly string[]).includes(t.status) };
  }
  return {
    key: incidentSubjectKey(inc.id), incidentId: inc.id, teamId, workspaceId: inc.workspaceId,
    severity: a.severity, status: inc.status, rule: inc.rule, fixTask, recurrenceCount: inc.recurrenceCount, scope: impactScope(inc),
    recovery: incidentSubjectRecovery(inc.recovery),
  };
}

/**
 * The default sender: gate the page. True only when the owner was actually
 * paged; a Buildd-owned or already-paged state is recorded and returns false.
 */
export function createGatedIncidentSender(deps: IncidentGateDeps): IncidentAlertSender {
  return async alert => {
    const inc = alert.incident;
    if (!inc?.workspaceId) return false;
    const teamId = await deps.loadTeamId(inc.workspaceId);
    if (!teamId) return false;

    const s = await subjectFor(alert, teamId, deps);
    const fingerprint = incidentFingerprint(s);
    const stored = await deps.loadStored(teamId, s.key).catch(() => null);
    if (stored && stored.fingerprint === fingerprint && verdictFromCode(stored.appliedAnswer)) return false;

    const rule = incidentEscalationRule(s);
    const judged = rule.owner === 'person' && rule.rail === 'no_next_step' && deps.judge
      ? await deps.judge(s).catch(() => null)
      : null;
    const verdict = judged?.verdict ?? rule;
    const code = verdictCode(verdict);
    const generation = s.recovery?.generation ?? null;
    const stamp = generation != null ? `@g${generation}` : '';
    const record = () => deps.record({
      teamId, workspaceId: inc.workspaceId, capability: ESCALATION_GATE_CAPABILITY, fingerprint,
      promptVersion: ESCALATION_GATE_PROMPT_VERSION, subjectType: INCIDENT_SUBJECT_TYPE, subjectId: s.key,
      ruleAnswer: verdictCode(rule), appliedAnswer: code, applied: true, status: 'applied',
      ...(judged ? { verdict: code, replay: judged.replay ?? null } : {}),
      reason: `${verdict.owner === 'person' ? `rule:${verdict.rail ?? 'person'}` : `rule:${verdict.action}`}${stamp}`,
    }).catch(() => {});

    if (verdict.owner !== 'person') {
      await record();
      return false;
    }
    // Page first. A page that throws is not recorded, so the next replay of
    // this state pages again rather than finding a "sent" row. Its words are
    // the projection's under the verdict just made, so push, Home and the
    // page say the same thing (I-6).
    const { message } = formatIncidentAlert(inc, { severity: alert.severity, reason: alert.reason }, { verdict: { ...verdict, generation } });
    await deps.notify(teamId, {
      title: alert.title, message, url: incidentDeepLink(inc.id), urlTitle: 'Open incident',
      priority: alert.priority,
    });
    await record();
    return true;
  };
}

/** An incident as Home reads it: what the projection needs. */
export interface IncidentNeedsYouRow extends IncidentForView {
  workspaceId: string | null;
  title: string;
}

/**
 * Pure. The Needs You items for unresolved incidents the projection says need
 * the owner (`projectIncident(...).needsYou`): a person verdict that is not
 * from an older generation, on an assessment that asks a person (or a
 * critical incident), nobody dismissed. Its sentence is the projection's, so
 * Home, the badge (which counts these rows), the page and the push agree.
 * `baseUrl` '' gives in-app links.
 */
export function incidentNeedsYouItems(
  rows: readonly IncidentNeedsYouRow[],
  verdicts: ReadonlyMap<string, IncidentVerdictView>,
  baseUrl = '',
  workspaceNameById: ReadonlyMap<string, string> = new Map(),
  opts: { now?: string | Date; timeZone?: string } = {},
): WaitingOnYouRawItem[] {
  const items: WaitingOnYouRawItem[] = [];
  for (const r of rows) {
    const p = projectIncident(r, verdicts.get(r.id) ?? null, opts);
    if (!p.needsYou) continue;
    items.push({
      kind: 'incident',
      incidentId: r.id,
      incidentTitle: r.title,
      incidentDecision: p.phase === 'decision',
      workspaceId: r.workspaceId ?? undefined,
      workspaceName: r.workspaceId ? workspaceNameById.get(r.workspaceId) ?? null : null,
      failureMessage: p.sentence,
      fixHref: incidentDeepLink(r.id, baseUrl),
      fixLabel: p.phase === 'decision' ? 'Choose…' : 'Open incident',
    });
  }
  return items;
}

/**
 * Home's read: unresolved high and critical incidents in these workspaces,
 * joined to their stored verdicts. One query for the incidents, one per team
 * for the verdicts. Never throws (Home keeps every other card).
 */
export async function loadIncidentNeedsYou(workspaceIds: readonly string[], opts: { timeZone?: string } = {}): Promise<WaitingOnYouRawItem[]> {
  if (workspaceIds.length === 0) return [];
  try {
    const [{ db }, { failureIncidents, workspaces: workspacesTable }, { and, inArray, ne }] = await Promise.all([
      import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
    ]);
    const workspaces = await db
      .select({ id: workspacesTable.id, teamId: workspacesTable.teamId, name: workspacesTable.name })
      .from(workspacesTable)
      .where(inArray(workspacesTable.id, [...workspaceIds]));
    if (workspaces.length === 0) return [];
    const rows = await db
      .select({
        id: failureIncidents.id, workspaceId: failureIncidents.workspaceId, title: failureIncidents.title,
        severity: failureIncidents.severity, status: failureIncidents.status, rule: failureIncidents.rule,
        firstSeenAt: failureIncidents.firstSeenAt, lastSeenAt: failureIncidents.lastSeenAt, resolvedAt: failureIncidents.resolvedAt,
        linkedFixTaskId: failureIncidents.linkedFixTaskId, recovery: failureIncidents.recovery,
      })
      .from(failureIncidents)
      .where(and(
        inArray(failureIncidents.workspaceId, workspaces.map(w => w.id)),
        ne(failureIncidents.status, 'resolved'),
        inArray(failureIncidents.severity, ['high', 'critical']),
      ))
      .limit(50);
    if (rows.length === 0) return [];
    const teamByWs = new Map(workspaces.map(w => [w.id, w.teamId]));
    const byTeam = new Map<string, string[]>();
    for (const r of rows) {
      const team = r.workspaceId ? teamByWs.get(r.workspaceId) : null;
      if (team) byTeam.set(team, [...(byTeam.get(team) ?? []), r.id]);
    }
    const verdicts = new Map<string, IncidentVerdictView>();
    for (const [teamId, ids] of byTeam) {
      for (const [id, v] of await loadIncidentVerdicts(teamId, ids)) verdicts.set(id, v);
    }
    return incidentNeedsYouItems(rows, verdicts, '', new Map(workspaces.map(w => [w.id, w.name])), { timeZone: opts.timeZone });
  } catch (err) {
    console.warn('[failure-incident-escalation] Home incident read failed (non-fatal):', (err as Error)?.message ?? err);
    return [];
  }
}

/** The assessment generation a stored verdict was made on (`…@g<n>` on its reason); null when unstamped. */
export function verdictGeneration(reason: string | null | undefined): number | null {
  const m = reason ? /@g(\d+)$/.exec(reason) : null;
  return m ? Number(m[1]) : null;
}

/** Stored incident verdicts for one team, with the generation each was made on. Never throws. */
export async function loadIncidentVerdicts(teamId: string, incidentIds: string[]): Promise<Map<string, IncidentVerdictView>> {
  const out = new Map<string, IncidentVerdictView>();
  if (incidentIds.length === 0) return out;
  try {
    const [{ db }, { decisionRecords }, { and, desc, eq, inArray }] = await Promise.all([
      import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
    ]);
    const keys = incidentIds.map(incidentSubjectKey);
    const rows = await db
      .select({ subjectId: decisionRecords.subjectId, appliedAnswer: decisionRecords.appliedAnswer, reason: decisionRecords.reason })
      .from(decisionRecords)
      .where(and(
        eq(decisionRecords.teamId, teamId), eq(decisionRecords.capability, ESCALATION_GATE_CAPABILITY),
        eq(decisionRecords.subjectType, INCIDENT_SUBJECT_TYPE), inArray(decisionRecords.subjectId, keys),
      ))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(keys.length * 4);
    for (const r of rows) {
      const v = verdictFromCode(r.appliedAnswer);
      const id = r.subjectId?.slice(INCIDENT_SUBJECT_TYPE.length + 1);
      if (id && v && !out.has(id)) out.set(id, { ...v, generation: verdictGeneration(r.reason) });
    }
  } catch (err) {
    console.warn('[failure-incident-escalation] stored verdict read failed (non-fatal):', (err as Error)?.message ?? err);
  }
  return out;
}

export function createDbIncidentGateDeps(): IncidentGateDeps {
  return {
    async loadTeamId(workspaceId) {
      const [{ db }, { workspaces }, { eq }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
      const [ws] = await db.select({ teamId: workspaces.teamId }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
      return ws?.teamId ?? null;
    },
    async loadFixTask(taskId) {
      const [{ db }, { tasks }, { eq }] = await Promise.all([import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm')]);
      const [t] = await db.select({ id: tasks.id, status: tasks.status }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
      return t ?? null;
    },
    async loadStored(teamId, key) {
      const v = await loadStoredRow(teamId, key);
      return v;
    },
    async record(input) {
      const { recordDecision } = await import('@buildd/core/decision-ledger');
      return recordDecision(input);
    },
    async notify(teamId, payload) {
      const { notifyTeam } = await import('./notify');
      await notifyTeam(teamId, 'needsAttention', payload);
    },
  };
}

async function loadStoredRow(teamId: string, key: string): Promise<{ fingerprint: string; appliedAnswer: string | null } | null> {
  const [{ db }, { decisionRecords }, { and, desc, eq }] = await Promise.all([
    import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
  ]);
  const [row] = await db
    .select({ fingerprint: decisionRecords.fingerprint, appliedAnswer: decisionRecords.appliedAnswer })
    .from(decisionRecords)
    .where(and(
      eq(decisionRecords.teamId, teamId), eq(decisionRecords.capability, ESCALATION_GATE_CAPABILITY),
      eq(decisionRecords.subjectType, INCIDENT_SUBJECT_TYPE), eq(decisionRecords.subjectId, key),
    ))
    .orderBy(desc(decisionRecords.createdAt))
    .limit(1);
  return row ?? null;
}
