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
 *  - a high incident nothing is fixing has no next step of its own: the owner,
 *    unless the optional `judge` (Jev) hands it to Buildd;
 *  - medium, low and resolved incidents are Buildd's and never page.
 *
 * One ping per transition: the verdict is filed under a fingerprint of the
 * state it was made on (severity, status, recurrences, scope tier, fix task
 * running). A replay of the same state reuses the stored verdict and does not
 * ping again; a worse severity, a recurrence, a wider scope or a fix task
 * ending is a new look. Never silences: a failed read or write pages.
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
import type { FailureIncidentSeverity, FailureIncidentStatus } from '@buildd/shared';
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import {
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
  /** The linked fix task; `running` is true while it is not finished. */
  fixTask: { id: string; running: boolean } | null;
  recurrenceCount: number;
  /** `impactScope` of the incident. */
  scope: number;
}

export const incidentSubjectKey = (incidentId: string) => `${INCIDENT_SUBJECT_TYPE}:${incidentId}`;

/** Pure. The deterministic verdict for an incident. */
export function incidentEscalationRule(s: IncidentSubject): EscalationVerdict {
  if (s.status === 'resolved') return { owner: 'buildd', by: 'rule', action: 'hold', reason: 'Resolved, nothing to do.' };
  if (s.severity === 'critical') {
    return { owner: 'person', by: 'rule', rail: 'critical_incident', reason: 'A critical platform incident: the owner is told once, whatever else is running.' };
  }
  if (s.fixTask?.running) {
    return { owner: 'buildd', by: 'rule', action: 'wait_machine', reason: `Buildd is fixing it (task ${s.fixTask.id.slice(0, 8)}).` };
  }
  if (s.severity === 'high') {
    return { owner: 'person', by: 'rule', rail: 'no_next_step', reason: 'Nothing is fixing this incident and Buildd has no next step of its own, so it comes to you.' };
  }
  return { owner: 'buildd', by: 'rule', action: 'hold', reason: 'Below the paging line; it stays on the incident page.' };
}

/** A hash of the state a verdict was made on. Occurrence counts are not state. */
export function incidentFingerprint(s: IncidentSubject): string {
  const state = {
    v: ESCALATION_GATE_PROMPT_VERSION, key: s.key, severity: s.severity, status: s.status,
    recurrence: s.recurrenceCount, tier: scopeTier(s.scope), fix: s.fixTask ? { id: s.fixTask.id, running: s.fixTask.running } : null,
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
  judge?: (s: IncidentSubject) => Promise<EscalationVerdict | null>;
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
    severity: a.severity, status: inc.status, fixTask, recurrenceCount: inc.recurrenceCount, scope: impactScope(inc),
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

    let verdict = incidentEscalationRule(s);
    if (verdict.owner === 'person' && verdict.rail === 'no_next_step' && deps.judge) {
      verdict = (await deps.judge(s).catch(() => null)) ?? verdict;
    }
    const code = verdictCode(verdict);
    await deps.record({
      teamId, workspaceId: inc.workspaceId, capability: ESCALATION_GATE_CAPABILITY, fingerprint,
      promptVersion: ESCALATION_GATE_PROMPT_VERSION, subjectType: INCIDENT_SUBJECT_TYPE, subjectId: s.key,
      ruleAnswer: code, appliedAnswer: code, applied: true, status: 'applied',
      reason: verdict.owner === 'person' ? `rule:${verdict.rail ?? 'person'}` : `rule:${verdict.action}`,
    }).catch(() => {});

    if (verdict.owner !== 'person') return false;
    await deps.notify(teamId, {
      title: alert.title, message: alert.message, url: incidentDeepLink(inc.id), urlTitle: 'Open incident',
      priority: alert.priority,
    });
    return true;
  };
}

/** Stored incident verdicts for one team, as Home, the badge and pushes read them. Never throws. */
export async function loadIncidentVerdicts(teamId: string, incidentIds: string[]): Promise<Map<string, EscalationVerdict>> {
  const out = new Map<string, EscalationVerdict>();
  if (incidentIds.length === 0) return out;
  try {
    const [{ db }, { decisionRecords }, { and, desc, eq, inArray }] = await Promise.all([
      import('@buildd/core/db'), import('@buildd/core/db/schema'), import('drizzle-orm'),
    ]);
    const keys = incidentIds.map(incidentSubjectKey);
    const rows = await db
      .select({ subjectId: decisionRecords.subjectId, appliedAnswer: decisionRecords.appliedAnswer })
      .from(decisionRecords)
      .where(and(
        eq(decisionRecords.teamId, teamId), eq(decisionRecords.capability, ESCALATION_GATE_CAPABILITY),
        eq(decisionRecords.subjectType, INCIDENT_SUBJECT_TYPE), inArray(decisionRecords.subjectId, keys),
      ))
      .orderBy(desc(decisionRecords.createdAt))
      .limit(keys.length * 4);
    for (const r of rows) {
      const v = verdictFromCode(r.appliedAnswer);
      if (r.subjectId && v && !out.has(r.subjectId)) out.set(r.subjectId.slice(INCIDENT_SUBJECT_TYPE.length + 1), v);
    }
  } catch (err) {
    console.warn('[incident-escalation] stored verdict read failed (non-fatal):', (err as Error)?.message ?? err);
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
