'use client';

/**
 * `?state=goal-criteria`: the mission's Goal criteria sheet in its
 * non-verifiable and ready states, with fixture data. The real page keeps the
 * sheet closed behind a pill, so a route screenshot never reaches it.
 */
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import MissionGoalCriteria from '../../(protected)/missions/[id]/MissionGoalCriteria';

const PROSE: GoalCriterion = {
  type: 'description',
  description: 'Each finished session gets a short quality read, and only the worrying ones get a deeper look',
  notMechanizableReason: 'Whether a read is useful is a judgement, not a script',
};

const RELABELLED: GoalCriterion = { type: 'all_prs_merged', label: 'Mission PR merged' };

// A run stored against the criterion before it was relabelled: its evidence
// must not show under the relabelled row.
const STALE_STATE: GoalCriteriaState = {
  evaluatedAt: '2026-01-01T00:00:00.000Z',
  evaluatedBy: 'auto',
  overall: 'UNVERIFIED',
  criteria: [
    { index: 0, type: 'all_prs_merged', verdict: 'UNVERIFIED', evidence: 'No PRs found for this mission yet', fingerprint: criterionFingerprint({ type: 'all_prs_merged' }) },
    { index: 1, type: 'no_open_tasks', verdict: 'pass', evidence: 'All 6 deliverable task(s) are closed', fingerprint: criterionFingerprint({ type: 'no_open_tasks' }) },
  ],
};

const PANELS: Array<{ title: string; props: Parameters<typeof MissionGoalCriteria>[0] }> = [
  {
    title: 'Only an AI-judged goal, mission has PRs',
    props: { missionId: 'fixture-1', criteria: [PROSE], criteriaState: null, autoVerify: true, missionPrCount: 4 },
  },
  {
    title: 'Only an AI-judged goal, nothing to infer from',
    props: { missionId: 'fixture-2', criteria: [PROSE], criteriaState: null, autoVerify: true, missionPrCount: 0 },
  },
  {
    title: 'Automatic checks and an AI-judged goal',
    props: { missionId: 'fixture-3', criteria: [RELABELLED, { type: 'no_open_tasks' }, PROSE], criteriaState: STALE_STATE, autoVerify: true, missionPrCount: 4 },
  },
];

export default function GoalCriteriaFixture() {
  return (
    <div className="min-h-screen bg-surface-1 p-4 md:p-8">
      <div className="max-w-xl mx-auto space-y-6">
        {PANELS.map(p => (
          <section key={p.title}>
            <p className="font-mono text-[11px] uppercase tracking-wide text-text-muted mb-2">{p.title}</p>
            <MissionGoalCriteria {...p.props} />
          </section>
        ))}
      </div>
    </div>
  );
}
