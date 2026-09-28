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
  const rows: Array<[string, ListMissionRow]> = [
    ['executor: local — nothing claimed yet', {
      id: 'fx-local-queued', title: 'Example mission run from a local session', status: 'active', executor: 'local',
      createdAt: new Date(now - 90 * 60_000),
      tasks: [done('a1'), task('a2', { roleSlug: 'builder' }), task('a3', { roleSlug: 'builder' })],
    }],
    ['executor: local — the session holds a claim', {
      id: 'fx-local-running', title: 'Example mission run from a local session', status: 'active', executor: 'local',
      createdAt: new Date(now - 90 * 60_000),
      tasks: [done('b1'), task('b2', { status: 'in_progress', roleSlug: 'builder', workers: [{ status: 'running', startedAt: new Date(now - 6 * 60_000) }] }), task('b3')],
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
  ];
  return rows.map(([caption, row]) => {
    const summary = summarizeMissionForCard(row, { now });
    const view = buildMissionCardView(row, { from: 'missions', now, summary });
    return { caption, view, model: buildMissionListCard(row, view, summary, { now }) };
  });
}
