/**
 * The `?state=mission-list-executor` dev fixture: the real missions-list cards
 * for the same illustrative mission under each executor setting, so the LOCAL
 * reading (`missions.executor = 'local'`) can be seen and screenshotted with no
 * database — a scrubbed prod clone has no local missions to show.
 *
 * Built with the same builders the missions page uses
 * (`summarizeMissionForCard` → `buildMissionCardView` → `buildMissionListCard`).
 */
import { buildMissionCardView, summarizeMissionForCard, type MissionCardView } from '@/lib/mission-card-view';
import { buildMissionListCard, type ListMissionRow, type ListTaskRow, type MissionListCardModel } from '@/lib/mission-list-card';

export { MISSION_LIST_EXECUTOR_FIXTURE_STATE } from './visual-review-fixtures';

export interface ExecutorFixtureCard {
  caption: string;
  view: MissionCardView;
  model: MissionListCardModel;
}

/**
 * Also covers the two readings the owner hit on the mobile Home cards: a
 * stranded local mission (with and without a refusable flip), and a mission
 * whose only open work waits on its dependencies (not an ask) next to one with
 * a real ask.
 */
export function missionListExecutorFixture(now: number = Date.now()): ExecutorFixtureCard[] {
  let clock = now - 90 * 60_000;
  const task = (id: string, over: Partial<ListTaskRow> = {}): ListTaskRow => {
    clock += 60_000;
    return { id, title: `feat(${id}): example change`, status: 'pending', taskClass: 'work', mode: 'execution', createdAt: new Date(clock), workers: [], ...over };
  };
  const done = (id: string) => task(id, {
    status: 'completed',
    workers: [{ status: 'completed', startedAt: new Date(now - 80 * 60_000), completedAt: new Date(now - 70 * 60_000), prNumber: 1, prUrl: 'https://example.test/pr/1', mergedAt: new Date(now - 60 * 60_000) }],
  });
  const fresh = (id: string, over: Partial<ListTaskRow> = {}) => task(id, { createdAt: new Date(now - 4 * 60_000), ...over });
  const prOpen = (id: string, pr: number, lifecycle: string) => task(id, {
    status: 'completed',
    workers: [{ status: 'completed', startedAt: new Date(now - 80 * 60_000), completedAt: new Date(now - 70 * 60_000), updatedAt: new Date(now - 70 * 60_000), prNumber: pr, prUrl: `https://example.test/pr/${pr}`, prLifecycleStatus: lifecycle }],
  });
  const reviewer = (id: string, parent: string) => task(id, { title: `[reviewer] ${parent}`, taskClass: 'attempt', parentTaskId: parent, status: 'in_progress' });
  const rows: Array<[string, ListMissionRow]> = [
    ['executor: local — tasks just filed, nothing claimed yet', {
      id: 'fx-local-queued', title: 'Example mission run from a local session', status: 'active', executor: 'local', workspaceId: 'fx-ws',
      createdAt: new Date(now - 90 * 60_000),
      tasks: [done('a1'), fresh('a2', { roleSlug: 'builder' }), fresh('a3', { roleSlug: 'builder' })],
    }],
    ['executor: local — the session holds a claim', {
      id: 'fx-local-running', title: 'Example mission run from a local session', status: 'active', executor: 'local', workspaceId: 'fx-ws',
      createdAt: new Date(now - 90 * 60_000),
      tasks: [done('b1'), task('b2', { status: 'in_progress', roleSlug: 'builder', workers: [{ status: 'running', startedAt: new Date(now - 6 * 60_000) }] }), task('b3')],
    }],
    ['executor: local — the session left, a task was filed after (stranded)', {
      id: 'fx-local-stranded', title: 'Example local mission nobody is working', status: 'active', executor: 'local', workspaceId: 'fx-ws',
      createdAt: new Date(now - 90 * 60_000),
      tasks: [done('s1'), task('s2', { roleSlug: 'builder' })],
    }],
    ['executor: local — stranded, and the flip would be refused (no workspace)', {
      id: 'fx-local-stranded-refused', title: 'Example local mission with no workspace', status: 'active', executor: 'local', workspaceId: null,
      createdAt: new Date(now - 90 * 60_000),
      tasks: [task('n1', { roleSlug: 'builder' })],
    }],
    ['executor: runner — the same queue, no runner on it (stall)', {
      id: 'fx-runner-stalled', title: 'Example mission on background runners', status: 'active', executor: 'runner',
      createdAt: new Date(now - 90 * 60_000),
      tasks: [done('c1'), task('c2'), task('c3')],
    }],
    ['executor: local, held — held wins', {
      id: 'fx-local-held', title: 'Example local mission, paused', status: 'active', executor: 'local', isHeld: true,
      createdAt: new Date(now - 90 * 60_000),
      tasks: [task('d1', { roleSlug: 'builder' })],
    }],
    ['runner — the only open task waits on two PRs a reviewer is on (not an ask)', {
      id: 'fx-dep-blocked', title: 'Example mission waiting on its dependencies', status: 'active', executor: 'runner', workspaceId: 'fx-ws',
      createdAt: new Date(now - 90 * 60_000),
      tasks: [prOpen('e1', 2, 'ci_green'), reviewer('e1r', 'e1'), prOpen('e2', 3, 'ci_green'), reviewer('e2r', 'e2'), task('e3', { dependsOn: ['e1', 'e2'] })],
    }],
    ['runner — the same, but one PR is green and nobody is on it (a real ask)', {
      id: 'fx-real-ask', title: 'Example mission with a PR to merge', status: 'active', executor: 'runner', workspaceId: 'fx-ws',
      createdAt: new Date(now - 90 * 60_000),
      tasks: [prOpen('f1', 4, 'ci_green'), task('f2', { dependsOn: ['f1'] })],
    }],
  ];
  return rows.map(([caption, row]) => {
    const summary = summarizeMissionForCard(row, { now });
    const view = buildMissionCardView(row, { from: 'missions', now, summary });
    return { caption, view, model: buildMissionListCard(row, view, summary, { now }) };
  });
}
