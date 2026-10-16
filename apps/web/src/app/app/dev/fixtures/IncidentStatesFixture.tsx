'use client';

/**
 * `?state=home-cards&data=incident-<case>`: the incident page in each recovery
 * state (failure-incident-recovery §17.3), drawn by the real projection:
 * waiting, repairing, retrying, retry-exhausted, decision, inconclusive,
 * recovered. `&data=incident-surfaces` is the task-page and mission-page
 * notices for a task whose stale question recovery superseded. The CI clone
 * has no incident rows, so this is where every state is seen. Invented data.
 */
import type { FailureIncidentRecovery } from '@buildd/shared';
import IncidentDetail from '@/components/incidents/IncidentDetail';
import MissionRecoveryNotice from '@/components/incidents/MissionRecoveryNotice';
import Notice from '@/components/ui/Notice';
import { incidentCause, incidentEvidence, projectIncident, type IncidentForView, type IncidentVerdictView } from '@/lib/incident-view';
import { taskRecoveryView } from '@/lib/incident-recovery-refs';

const NOW = '2026-10-11T14:00:00.000Z';
const TZ = 'UTC';
const SUBJECT = 'fxbill01-seats';
const FIX = 'fxscrub1-repair';
const prHref = (n: number) => `https://github.com/example/project/pull/${n}`;

function recovery(over: Partial<FailureIncidentRecovery> = {}): FailureIncidentRecovery {
  return {
    v: 1, generation: 2,
    cause: { reasonCode: 'path_overlap.blocker_open', rule: 'path_overlap_stall', ownership: 'workflow' },
    subjects: [{ kind: 'task', id: SUBJECT }],
    blockers: [{ kind: 'pr', id: '412', state: 'open', observedAt: '2026-10-11T13:56:00.000Z' }],
    overlappingPaths: ['apps/web/src/lib/billing/seats.ts', 'apps/web/src/lib/billing/proration.ts'],
    observation: { observedAt: '2026-10-11T13:56:00.000Z', source: 'sweep', evidenceRevision: '9f2c41ab7d10e3c5' },
    firstSeenAt: '2026-10-11T11:40:00.000Z', lastSeenAt: '2026-10-11T13:56:00.000Z', lastProgressAt: '2026-10-11T12:10:00.000Z',
    owner: 'buildd', state: 'waiting',
    nextAction: { kind: 'wait', label: 'Waiting for PR #412 to land.', key: 'recovery:fixture:g2' },
    nextCheckAt: '2026-10-11T14:20:00.000Z',
    verification: { predicate: 'path_overlap.every_subject_progressed', params: {} },
    budget: { spent: 0, limit: 3, deadlineAt: '2026-10-11T17:40:00.000Z', spentKeys: [] },
    attempts: [],
    ...over,
  };
}

const attempt = (n: number, action = 'wake_subject') => ({
  key: `recovery:fixture:task:${SUBJECT}:path_overlap.blocker_merged_unreleased:${action}:g2:a${n}`,
  action, subject: { kind: 'task' as const, id: SUBJECT }, at: `2026-10-11T13:${String(10 + n * 12).padStart(2, '0')}:00.000Z`, generation: 2,
});

const decision = {
  question: 'The billing seats task and PR #412\'s fix are waiting on each other. Choose one to stop.',
  options: [
    { capability: 'cancel_attempt' as const, label: 'Cancel the stale attempt', effect: 'Stops the attempt on PR #412 so the billing seats task can start.' },
    { capability: 'narrow_subject_manifest' as const, label: 'Narrow the waiting task', effect: 'Limits the waiting task to the files it declared.' },
    { capability: 'dismiss' as const, label: 'Leave both waiting', effect: 'Nothing changes; it leaves Needs You.' },
  ],
  recommended: 'cancel_attempt' as const,
};

export const INCIDENT_FIXTURE_CASES: Record<string, Partial<IncidentForView>> = {
  waiting: { recovery: recovery() },
  repairing: {
    recovery: recovery({
      cause: { reasonCode: 'path_overlap.blocker_merged_unreleased', rule: 'path_overlap_stall', ownership: 'workflow' },
      blockers: [{ kind: 'pr', id: '412', state: 'merged', observedAt: NOW }],
      state: 'recovering', nextCheckAt: '2026-10-11T14:02:00.000Z',
      nextAction: { kind: 'release_blocker', label: 'PR #412 landed; Buildd is releasing its files.', key: attempt(1, 'release_blocker').key },
      attempts: [attempt(1, 'release_blocker')], budget: { spent: 1, limit: 3, deadlineAt: '2026-10-11T17:40:00.000Z', spentKeys: [attempt(1, 'release_blocker').key] },
    }),
  },
  retrying: {
    recovery: recovery({
      cause: { reasonCode: 'path_overlap.blocker_merged_unreleased', rule: 'path_overlap_stall', ownership: 'workflow' },
      blockers: [{ kind: 'pr', id: '412', state: 'merged', observedAt: NOW }],
      state: 'recovering', nextCheckAt: '2026-10-11T14:02:00.000Z',
      nextAction: { kind: 'wake_subject', label: 'PR #412 landed; Buildd restarted the billing seats task.', key: attempt(2).key },
      attempts: [attempt(1), attempt(2)], budget: { spent: 2, limit: 3, deadlineAt: '2026-10-11T17:40:00.000Z', spentKeys: [attempt(1).key, attempt(2).key] },
    }),
  },
  'retry-exhausted': {
    recovery: recovery({
      cause: { reasonCode: 'infrastructure_failure.visual_qa.scrub', rule: 'path_overlap_stall', ownership: 'infrastructure' },
      blockers: [], overlappingPaths: [], state: 'needs_operator', owner: 'operator',
      capabilityGap: { capability: 'repair_infrastructure:visual_qa.scrub', reason: 'the screenshot database scrub still fails after three repairs' },
      nextAction: { kind: 'operator', label: 'An operator repairs the scrub step; the audit resumes on its own once a capture passes.', key: 'k' },
      nextCheckAt: '2026-10-11T16:00:00.000Z',
      attempts: [attempt(1, 'retry_capture'), attempt(2, 'retry_capture'), attempt(3, 'retry_capture')],
      budget: { spent: 3, limit: 3, deadlineAt: '2026-10-11T17:40:00.000Z', spentKeys: [] },
    }),
  },
  decision: {
    recovery: recovery({
      cause: { reasonCode: 'path_overlap.cycle', rule: 'path_overlap_stall', ownership: 'workflow' },
      state: 'needs_decision', owner: 'person', nextCheckAt: null, decision,
      nextAction: { kind: 'decide', label: decision.question, key: 'recovery:fixture:g2' },
    }),
  },
  inconclusive: {
    recovery: recovery({ state: 'inconclusive', nextAction: { kind: 'recheck', label: 'The facts could not be read in full.', key: 'k' } }),
  },
  recovered: {
    status: 'resolved', resolvedAt: '2026-10-11T13:10:00.000Z',
    recovery: recovery({
      state: 'recovered', nextAction: null, nextCheckAt: null,
      blockers: [{ kind: 'pr', id: '412', state: 'merged', observedAt: '2026-10-11T13:10:00.000Z' }],
      verification: { predicate: 'path_overlap.every_subject_progressed', params: { summary: 'the billing seats task started once PR #412 landed.' } },
      attempts: [attempt(1)],
    }),
  },
};

function incidentFor(c: string): IncidentForView & { title: string; reasonCode: string; occurrenceCount: number; recurrenceCount: number } {
  return {
    id: 'fxinc001', status: 'open', severity: 'high', rule: 'path_overlap_stall', linkedFixTaskId: null,
    firstSeenAt: '2026-10-11T11:40:00.000Z', lastSeenAt: '2026-10-11T13:56:00.000Z',
    title: '1 task(s) deferred on path overlap behind PR #412 with no progress', reasonCode: 'path_overlap.no_progress',
    occurrenceCount: 6, recurrenceCount: 0,
    ...INCIDENT_FIXTURE_CASES[c],
  };
}

const personVerdict: IncidentVerdictView = { owner: 'person', by: 'rule', rail: 'no_next_step', reason: 'x', generation: 2 };
const builddVerdict: IncidentVerdictView = { owner: 'buildd', by: 'rule', action: 'hold', reason: 'x', generation: 2 };

/** The Home rows for the decision case and a critical one, as `incidentNeedsYouItems` writes them. */
export function incidentHomeItems() {
  const decided = incidentFor('decision');
  const critical = { ...incidentFor('waiting'), id: 'fxinc002', severity: 'critical' as const, rule: 'retry_fork' as const, recovery: null, title: 'Same failure across tasks' };
  return [
    { incident: decided, title: 'Two pieces of work are waiting on each other', p: projectIncident(decided, personVerdict, { now: NOW, timeZone: TZ, prHref }) },
    { incident: critical, title: 'The same failure across 9 tasks', p: projectIncident(critical, { owner: 'person', by: 'rule', rail: 'critical_incident', reason: 'x' }, { now: NOW, timeZone: TZ }) },
  ];
}

export default function IncidentStatesFixture({ which }: { which: string }) {
  if (which === 'surfaces') {
    const stale = taskRecoveryView(incidentFor('repairing'), { now: NOW, timeZone: TZ })!;
    const exhausted = taskRecoveryView(incidentFor('retry-exhausted'), { now: NOW, timeZone: TZ })!;
    return (
      <main data-testid="incident-surfaces-fixture" className="min-h-screen pt-4 px-4 pb-8 md:p-8">
        <div className="max-w-3xl mx-auto space-y-8">
          <section className="space-y-2">
            <h2 className="text-meta text-text-muted">Task page: a stale question recovery superseded</h2>
            <h1 className="text-heading font-bold">Visual audit: settings and connections pages</h1>
            <Notice tone="info" title={stale.stateWord} action={{ label: 'Open incident', href: '#' }} data-testid="task-recovery-status">
              <p>{stale.sentence}</p>
              <p className="text-meta text-text-muted">Owner: {stale.ownerLabel}</p>
            </Notice>
          </section>
          <section className="space-y-2">
            <h2 className="text-meta text-text-muted">Mission page notice</h2>
            <MissionRecoveryNotice items={[
              { taskId: 'a', title: 'Visual audit: settings and connections pages', view: exhausted },
              { taskId: 'b', title: 'Billing seats: prorate changes mid-cycle', view: stale },
            ]} />
          </section>
        </div>
      </main>
    );
  }
  const c = INCIDENT_FIXTURE_CASES[which] ? which : 'waiting';
  const inc = incidentFor(c);
  const p = projectIncident(inc, c === 'decision' ? personVerdict : builddVerdict, { now: NOW, timeZone: TZ, prHref });
  return (
    <div data-testid="incident-states-fixture" data-case={c}>
      <IncidentDetail
        incidentId={inc.id}
        headline={incidentCause(inc.recovery?.cause.reasonCode ?? inc.reasonCode, inc.rule)}
        meta="High incident · Workspace 3"
        projection={p}
        timeZone={TZ}
        fixTask={c === 'retry-exhausted' ? { id: FIX, title: 'Repair the screenshot database scrub', status: 'completed' } : null}
        affected={{ tasks: [{ id: SUBJECT, label: 'Billing seats: prorate changes mid-cycle', href: '#' }], moreTasks: 0, prs: [{ label: 'PR #412', href: prHref(412) }] }}
        evidence={incidentEvidence(inc, TZ)}
        readOnly
        now={NOW}
      />
    </div>
  );
}
