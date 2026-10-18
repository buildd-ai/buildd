/**
 * The six canonical mission lifecycle states from the Mission state Living Spec,
 * as data: the same rows the missions page feeds the real card builders
 * (`summarizeMissionForCard` → `buildMissionCardView` → `buildMissionListCard`).
 * No parallel derivation lives here; `mission-state-regression.test.ts` asserts
 * what those builders say about each row, so a lifecycle change shows up as one
 * failing file in the ordinary unit-test run.
 */
import { buildMissionCardView, summarizeMissionForCard, type MissionCardView } from '@/lib/mission-card-view';
import { buildMissionListCard, type ListMissionRow, type ListTaskRow, type MissionListCardModel } from '@/lib/mission-list-card';

export type MissionLifecycleKey =
  | 'new-organizer-queued'
  | 'organizer-working'
  | 'implementation-active'
  | 'awaiting-mission-pr-merge'
  | 'verification-due'
  | 'delivered';

export interface MissionLifecycleFixture {
  key: MissionLifecycleKey;
  caption: string;
  row: ListMissionRow;
  view: MissionCardView;
  model: MissionListCardModel;
}

/** Declared, never evaluated: latent until the work is done. */
const CRITERIA = [{ type: 'all_prs_merged', label: 'Mission PR merged' }, { type: 'no_open_tasks', label: 'No open tasks' }];

export function missionLifecycleFixtures(now: number = Date.now()): MissionLifecycleFixture[] {
  const min = (n: number) => new Date(now - n * 60_000);
  let clock = now - 120 * 60_000;
  const task = (id: string, over: Partial<ListTaskRow> = {}): ListTaskRow => {
    clock += 60_000;
    return { id, title: `feat(${id}): example change`, status: 'pending', taskClass: 'work', mode: 'execution', createdAt: new Date(clock), workers: [], ...over };
  };
  const organizer = (over: Partial<ListTaskRow> = {}) =>
    task('org', { title: 'Mission: Example goal', taskClass: 'bookkeeping', mode: 'planning', roleSlug: 'organizer', ...over });
  const merged = (id: string, pr: number) => task(id, {
    status: 'completed',
    workers: [{ status: 'completed', startedAt: min(100), completedAt: min(90), prNumber: pr, prUrl: `https://example.test/pr/${pr}`, mergedAt: min(80), prLifecycleStatus: 'merged' }],
  });
  const open = (id: string, pr: number) => task(id, {
    status: 'completed',
    workers: [{ status: 'completed', startedAt: min(100), completedAt: min(90), updatedAt: min(90), prNumber: pr, prUrl: `https://example.test/pr/${pr}`, prLifecycleStatus: 'ci_green' }],
  });
  const base = { title: 'Example goal', status: 'active', executor: 'runner', workspaceId: 'fx-ws', goalCriteria: CRITERIA, goalCriteriaState: null } as const;

  const specs: Array<[MissionLifecycleKey, string, ListMissionRow]> = [
    ['new-organizer-queued', 'New mission: the organizer is queued, nothing else exists', {
      ...base, id: 'fx-new', createdAt: min(2),
      tasks: [organizer({ createdAt: min(2) })],
    }],
    ['organizer-working', 'The organizer is planning', {
      ...base, id: 'fx-planning', createdAt: min(10),
      tasks: [organizer({ status: 'in_progress', workers: [{ status: 'running', startedAt: min(3) }] })],
    }],
    ['implementation-active', 'Implementation: one task done, one running, one queued', {
      ...base, id: 'fx-building', createdAt: min(110),
      tasks: [
        organizer({ status: 'completed', workers: [{ status: 'completed', startedAt: min(108), completedAt: min(105) }] }),
        merged('a1', 1),
        task('a2', { status: 'in_progress', roleSlug: 'builder', workers: [{ status: 'running', startedAt: min(6) }] }),
        task('a3', { roleSlug: 'builder', dependsOn: ['a2'] }),
      ],
    }],
    ['awaiting-mission-pr-merge', 'All work done; the last PR is green and waits to merge', {
      ...base, id: 'fx-merge', createdAt: min(110),
      tasks: [merged('b1', 1), open('b2', 2)],
    }],
    ['verification-due', 'All work landed; the criteria have no verdict yet', {
      ...base, id: 'fx-verify', createdAt: min(110),
      tasks: [merged('c1', 1), merged('c2', 2)],
    }],
    ['delivered', 'Delivered: every criterion passed', {
      ...base, id: 'fx-done', status: 'completed', createdAt: min(110), completedAt: min(5),
      goalCriteriaState: {
        overall: 'pass',
        criteria: CRITERIA.map(c => ({ verdict: 'pass', type: c.type, label: c.label, evidence: 'ok' })),
      },
      tasks: [merged('d1', 1), merged('d2', 2)],
    }],
  ];

  return specs.map(([key, caption, row]) => {
    const summary = summarizeMissionForCard(row, { now });
    const view = buildMissionCardView(row, { from: 'missions', now, summary });
    return { key, caption, row, view, model: buildMissionListCard(row, view, summary, { now }) };
  });
}
