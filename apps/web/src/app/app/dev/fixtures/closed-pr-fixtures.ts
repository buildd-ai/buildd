/**
 * `?state=closed-pr&case=<case>`: the mission situation block for a
 * deliverable whose PR closed without merging, and the same mission after its
 * replacement is recorded. Each case is derived by the real accessor
 * (`deriveMissionStateView`) from an illustrative completion summary, so the
 * wording is the product's, not the fixture's.
 *
 *   awaiting-confirmation  detection found a likely replacement: Confirm / Not this / Mark abandoned
 *   no-suggestion          nothing says where the work went: Mark abandoned only
 *   replaced               the replacement is recorded: the task reads "Merged in #N", nothing is waiting
 *
 * The block carries `data-verify-surface="mission-situation"` in every case,
 * so scripts/qa/plans/closed-pr-surfaces.json captures each as SurfaceEvidence.
 * Illustrative values only (the repo is public).
 */
import { deriveMissionStateView, type MissionSituation, type MissionStateInput } from '@/lib/mission-state-view';

export const CLOSED_PR_FIXTURE_STATE = 'closed-pr';
export const CLOSED_PR_FIXTURE_CASES = ['awaiting-confirmation', 'no-suggestion', 'replaced'] as const;
export type ClosedPrFixtureCase = (typeof CLOSED_PR_FIXTURE_CASES)[number];

export const CLOSED_PR_MISSION_ID = 'fixture-mission-closed-pr';
export const CLOSED_PR_NUMBER = 34;
export const REPLACEMENT_PR_NUMBER = 41;

const TASK_ID = 'fixture-task-closed-pr';
const PR_URL = `https://example.test/acme/widgets/pull/${CLOSED_PR_NUMBER}`;
const suggestion = {
  repo: 'acme/widgets', prNumber: REPLACEMENT_PR_NUMBER, prUrl: `https://example.test/acme/widgets/pull/${REPLACEMENT_PR_NUMBER}`,
  signal: 'sibling_task' as const, why: 'merged by "fix: wire the route" in the same mission', score: 0.6,
};

const base: MissionStateInput = { status: 'active', isHeld: false, activeAgents: 0, health: 'NOMINAL' };

export interface ClosedPrFixture {
  case: ClosedPrFixtureCase;
  situation: MissionSituation;
  /** The closed PR's task as the task page reads it: the SUPERSEDED delivery's successor, when recorded. */
  task: { title: string; prNumber: number; supersededByPr: number | null };
}

/** Pure: `?case=` to a case. Unknown values fall back to the one that needs a decision. */
export function parseClosedPrFixtureCase(q: URLSearchParams): ClosedPrFixtureCase {
  const c = q.get('case');
  return (CLOSED_PR_FIXTURE_CASES as readonly string[]).includes(c ?? '') ? (c as ClosedPrFixtureCase) : 'awaiting-confirmation';
}

export function closedPrFixture(c: ClosedPrFixtureCase): ClosedPrFixture {
  const task = { title: 'Wire the route', prNumber: CLOSED_PR_NUMBER, supersededByPr: c === 'replaced' ? REPLACEMENT_PR_NUMBER : null };
  if (c === 'replaced') {
    // The supersession is recorded, so the closed PR counts as shipped and the mission can complete.
    return { case: c, task, situation: deriveMissionStateView({ ...base, completion: { ok: true } as MissionStateInput['completion'] }).situation };
  }
  const detail = {
    taskId: TASK_ID, title: task.title, prNumber: CLOSED_PR_NUMBER, prUrl: PR_URL, closedUnsuperseded: true,
    ...(c === 'awaiting-confirmation' ? { suggestion } : {}),
  };
  const view = deriveMissionStateView({
    ...base,
    completion: { ok: false, code: 'awaiting_merge', reason: 'closed unmerged', awaitingMerge: 1, awaitingMergeDetails: [detail] } as MissionStateInput['completion'],
  });
  return { case: c, task, situation: view.situation };
}

export function closedPrFixtureLinks(): { label: string; href: string }[] {
  return CLOSED_PR_FIXTURE_CASES.map(c => ({ label: c, href: `?state=${CLOSED_PR_FIXTURE_STATE}&case=${c}` }));
}
