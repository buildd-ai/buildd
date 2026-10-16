/** Development-only chart data for the selection state, independent of clone history. */
import { buildFleetSnapshot, type FleetWorkerRow } from '@/lib/fleet-view';

export function resolveRunnerLanesSample(raw: string | string[] | undefined, env = process.env.NODE_ENV): boolean {
  return env === 'development' && (Array.isArray(raw) ? raw[0] : raw) === 'sample';
}

export function sampleRunnerLanes(now: number) {
  const ago = (minutes: number) => new Date(now - minutes * 60_000);
  const runner = 'http://sample-runner.local:8766';
  const workers: FleetWorkerRow[] = [
    { id: 'sample-a', accountId: 'sample-account', runner, status: 'completed', startedAt: ago(110), completedAt: ago(65), task: { id: 'sample-task-a', title: 'feat: clarify the task header', roleSlug: 'builder', missionId: 'sample-mission' } },
    { id: 'sample-b', accountId: 'sample-account', runner, status: 'running', startedAt: ago(45), task: { id: 'sample-task-b', title: 'fix: keep chart captions readable on a phone', roleSlug: 'builder', missionId: 'sample-mission' } },
    { id: 'sample-c', accountId: 'sample-account', runner, status: 'failed', startedAt: ago(100), completedAt: ago(55), task: { id: 'sample-task-c', title: 'research: compare the reporting options', roleSlug: 'researcher', missionId: 'sample-other-mission' } },
    // Claims from a person's own coding session: the "Your sessions" group.
    { id: 'sample-s1', accountId: 'sample-account', runner: 'mcp', status: 'running', startedAt: ago(25), task: { id: 'sample-task-s1', title: 'docs: explain how pausing works', roleSlug: null, missionId: null } },
    { id: 'sample-s2', accountId: 'sample-account', runner: 'mcp', status: 'waiting_input', startedAt: ago(70), waitingFor: { prompt: 'Keep the old name?' }, task: { id: 'sample-task-s2', title: 'refactor: one name for runner slots', roleSlug: null, missionId: 'sample-mission' } },
  ];
  return {
    fleet: buildFleetSnapshot([{ id: 'sample-runner', accountId: 'sample-account', localUiUrl: runner, maxConcurrentWorkers: 3, lastHeartbeatAt: ago(0) }], workers, { now }),
    idle: [],
    missions: { 'sample-mission': { title: 'Make Health and Activity easier to read on a phone', landed: 2, total: 5 } },
  };
}
