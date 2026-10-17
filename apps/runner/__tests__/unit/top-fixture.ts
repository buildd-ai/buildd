/**
 * A fixed `buildd top` state for the renderer, reducer and key tests: one
 * mission with running, asking, waiting and done work, a second mission, and
 * loose tasks. Made-up titles and ids only.
 */
import { initialState, reduce, type TopState, type TopTask, type TopWorker } from '../../src/top/state';

/** 2026-03-10 15:00 local time. */
export const NOW = new Date(2026, 2, 10, 15, 0, 0).getTime();
const min = 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const MISSION = { id: 'm-tui-0000-0000', title: 'Runner TUI', isHeld: false, executor: 'runner' };
const MISSION2 = { id: 'm-spec-0000-0000', title: 'Specs import', isHeld: true, executor: 'runner' };
const LOCAL = { id: 'm-local-000-0000', title: 'Local only', isHeld: false, executor: 'local' };

export const TASKS: TopTask[] = [
  { id: 't-name', title: 'name override', status: 'in_progress', missionId: MISSION.id, mission: MISSION, roleSlug: 'builder', updatedAt: iso(NOW - 12 * min) },
  { id: 't-single', title: 'single instance', status: 'in_progress', missionId: MISSION.id, mission: MISSION, roleSlug: 'builder', updatedAt: iso(NOW - 4 * min) },
  { id: 't-hint', title: 'installer hint', status: 'in_progress', missionId: MISSION.id, mission: MISSION, roleSlug: 'builder', updatedAt: iso(NOW - 9 * min) },
  { id: 't-top', title: 'buildd top', status: 'pending', missionId: MISSION.id, mission: MISSION, roleSlug: 'builder', dependsOn: ['t-name'] },
  { id: 't-docs', title: 'docs page', status: 'pending', missionId: MISSION.id, mission: MISSION, roleSlug: 'writer', startAt: iso(NOW + 2 * 60 * min) },
  { id: 't-other', title: 'heartbeat name', status: 'assigned', missionId: MISSION.id, mission: MISSION, roleSlug: 'builder' },
  { id: 't-draft', title: 'spec draft', status: 'completed', missionId: MISSION.id, mission: MISSION, updatedAt: iso(NOW - 90 * min) },
  { id: 't-old', title: 'yesterday work', status: 'completed', missionId: MISSION.id, mission: MISSION, updatedAt: iso(NOW - 30 * 60 * min) },
  { id: 't-import', title: 'import repo specs', status: 'pending', missionId: MISSION2.id, mission: MISSION2, roleSlug: 'builder' },
  { id: 't-imported', title: 'area cards', status: 'completed', missionId: MISSION2.id, mission: MISSION2, updatedAt: iso(NOW - 60 * min) },
  { id: 't-loose', title: 'fix flaky test', status: 'pending', missionId: null, roleSlug: 'builder' },
  { id: 't-local', title: 'person session work', status: 'pending', missionId: LOCAL.id, mission: LOCAL },
];

export const WORKERS: TopWorker[] = [
  {
    id: 'w-name', taskId: 't-name', taskTitle: 'name override', status: 'working', startedAt: NOW - 12 * min,
    currentAction: 'Edit config.ts', tokenTally: { inputTokens: 38_000, outputTokens: 3_200 },
    milestones: [{ type: 'phase', label: 'Reading the config loader', ts: NOW - 11 * min }, { type: 'action', label: 'Edit config.ts', ts: NOW - 1 * min }],
    toolCalls: [
      { name: 'TodoWrite', timestamp: NOW - 11 * min, input: { todos: [
        { content: 'Read config loader', status: 'completed' },
        { content: 'Add BUILDD_RUNNER_NAME', status: 'in_progress' },
        { content: 'Test heartbeat payload', status: 'pending' },
      ] } },
      { name: 'Read', timestamp: NOW - 10 * min, input: { file_path: '/repo/apps/runner/src/config.ts' } },
      { name: 'Edit', timestamp: NOW - 1 * min, input: { file_path: '/repo/apps/runner/src/config.ts' } },
    ],
    prUrl: 'https://github.com/example/repo/pull/12',
  },
  {
    id: 'w-single', taskId: 't-single', taskTitle: 'single instance', status: 'working', startedAt: NOW - 4 * min,
    currentAction: 'bun run test __tests__/unit/runner-socket.test.ts', tokenTally: { inputTokens: 7_000, outputTokens: 900 },
  },
  {
    id: 'w-hint', taskId: 't-hint', taskTitle: 'installer hint', status: 'waiting', startedAt: NOW - 9 * min,
    waitingFor: { type: 'question', prompt: 'Print the URL or open the browser?', options: [{ label: 'Print the URL' }, { label: 'Open the browser' }] },
  },
];

export function fixtureState(): TopState {
  let s = initialState({ hostname: 'laptop-1234' });
  s = reduce(s, { type: 'runner', pid: 4242, version: '0.340.0' });
  s = reduce(s, { type: 'config', maxConcurrent: 3, builddServer: 'https://buildd.dev' });
  s = reduce(s, { type: 'workers', workers: WORKERS });
  s = reduce(s, { type: 'tasks', tasks: TASKS });
  s = reduce(s, { type: 'connection', online: true });
  return s;
}
