/**
 * `taskRowsProgress`: the Overview strip's cells from task rows as a list
 * query loads them (buildd top's progress row, spec c7410e76 R-29, AC-14).
 */
import { describe, expect, it } from 'bun:test';
import { buildMissionBoard, toBoardTaskInput } from './mission-board';
import { overviewProgress } from './mission-overview';
import { taskRowsProgress } from './mission-strip-order';

const T0 = Date.UTC(2026, 0, 1, 12, 0, 0);
const at = (n: number) => new Date(T0 + n * 60_000);

let seq = 0;
function row(status: string, over: Record<string, unknown> = {}) {
  seq += 1;
  const id = `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}`;
  const worker = status === 'pending' ? [] : [{
    id: `w-${seq}`, taskId: id,
    status: status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'running',
    startedAt: at(seq), createdAt: at(seq), updatedAt: at(seq + 1),
    completedAt: status === 'completed' || status === 'failed' ? at(seq + 2) : null,
    mergedAt: null, prUrl: null, prNumber: null, prLifecycleStatus: null,
  }];
  return {
    id, title: `feat(x): example task ${seq}`, status, taskClass: 'work', mode: 'execution', kind: 'engineering',
    roleSlug: 'builder', outputRequirement: 'none', createdAt: at(seq), updatedAt: at(seq), dependsOn: [],
    workers: worker, ...over,
  };
}

describe('taskRowsProgress', () => {
  it('AC-14: 8 done, 2 in progress, 3 waiting draws done first, then in progress, then waiting', () => {
    const rows = [
      row('pending'), row('in_progress'), row('completed'), row('completed'), row('pending'),
      row('completed'), row('completed'), row('in_progress'), row('completed'), row('completed'),
      row('completed'), row('pending'), row('completed'),
    ];
    const progress = taskRowsProgress(rows);
    expect(progress.map(c => c.group)).toEqual([
      ...Array(8).fill('done'), ...Array(2).fill('active'), ...Array(3).fill('waiting'),
    ]);
    expect(progress.slice(0, 8).every(c => c.state === 'landed')).toBe(true);
    expect(progress.slice(8, 10).every(c => c.state === 'running')).toBe(true);
  });

  it('is the mission page projection over the same rows', () => {
    const rows = [row('completed'), row('failed'), row('in_progress'), row('pending')];
    const model = buildMissionBoard({ tasks: rows.map(r => toBoardTaskInput(r)), now: T0 + 3_600_000, missionCreatedAt: T0, missionStatus: 'active' });
    expect(taskRowsProgress(rows)).toEqual(overviewProgress(model));
  });

  it('R-22: an organizer run is not a square, and a cancelled task has no cell', () => {
    const rows = [
      row('completed'),
      row('in_progress', { title: 'Mission: example goal', taskClass: 'bookkeeping', mode: 'planning', roleSlug: 'organizer', kind: 'coordination' }),
      row('cancelled', { workers: [] }),
    ];
    expect(taskRowsProgress(rows)).toEqual([{ state: 'landed', group: 'done' }]);
  });

  it('a failed task keeps its failed state in the in-progress group', () => {
    const progress = taskRowsProgress([row('failed')]);
    expect(progress).toEqual([{ state: 'failed', group: 'active' }]);
  });
});
