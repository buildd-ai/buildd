/**
 * Illustrative mission fixtures for the mission detail tests — invented titles
 * and ids, no real mission or task data. Sizes follow the design's test plan:
 * 3 (unphased), 15 (three phases, the wireframe shape) and 45 (above the
 * pulse's 40-row fold).
 */
import type { MissionFeedTaskInput } from '@/lib/mission-pulse';

const START = Date.UTC(2026, 0, 1, 9, 0, 0);

function makeTask(seq: number, id: string, over: Partial<MissionFeedTaskInput> = {}): MissionFeedTaskInput {
  return {
    id,
    title: `Example task ${id}`,
    status: 'pending',
    taskClass: 'work',
    createdAt: new Date(START + seq * 60_000).toISOString(),
    updatedAt: new Date(START + seq * 60_000).toISOString(),
    ...over,
  };
}

const phase = (index: number, label: string) => ({ missionPhaseIndex: index, missionPhaseLabel: label });
const done = { status: 'completed' } as const;
const running = (seq: number) => ({
  status: 'in_progress',
  worker: { status: 'running', startedAt: new Date(START + seq * 60_000).toISOString() },
});
const asking = (seq: number) => ({
  status: 'in_progress',
  worker: { status: 'waiting_input', updatedAt: new Date(START + seq * 60_000).toISOString() },
});

/** Fixture clock: after every fixture task was created. */
export const FIXTURE_NOW = START + 24 * 60 * 60_000;

/** Work (deliverable) task ids — the rows the list must render exactly once. */
export function workTaskIds(tasks: readonly MissionFeedTaskInput[]): string[] {
  return tasks.filter(t => t.taskClass === 'work').map(t => t.id);
}

export function fixtureMission(size: 3 | 15 | 45): MissionFeedTaskInput[] {
  let seq = 0;
  const t = (id: string, over: Partial<MissionFeedTaskInput> = {}) => makeTask(++seq, id, over);

  if (size === 3) {
    return [t('u1', done), t('u2', running(seq + 1)), t('u3')];
  }

  if (size === 15) {
    const THINK = phase(0, 'THINK');
    const BUILD = phase(1, 'BUILD');
    const CHECK = phase(2, 'CHECK');
    return [
      t('th1', { ...THINK, ...done }), t('th2', { ...THINK, ...done }),
      t('th3', { ...THINK, ...done }), t('th4', { ...THINK, ...done }),
      t('b1', { ...BUILD, ...done }), t('b2', { ...BUILD, ...asking(seq + 1) }),
      t('b3', { ...BUILD, ...running(seq + 1) }), t('b4', { ...BUILD, ...running(seq + 1) }),
      t('b5', { ...BUILD, dependsOn: ['b2'] }),
      t('c1', { ...CHECK }), t('c2', { ...CHECK }), t('c3', { ...CHECK }),
      t('c4', { ...CHECK }), t('c5', { ...CHECK }), t('c6', { ...CHECK }),
      // Never rows: an attempt under b1 and an orchestrator planning run.
      t('b1-retry', { taskClass: 'attempt', parentTaskId: 'b1', ...done }),
      t('plan', { taskClass: 'bookkeeping', mode: 'planning', ...done }),
    ];
  }

  const out: MissionFeedTaskInput[] = [];
  for (let i = 0; i < 15; i++) out.push(t(`p0-${i}`, { ...phase(0, 'THINK'), ...done }));
  for (let i = 0; i < 15; i++) {
    const state = i < 2 ? asking(seq + 1) : i < 5 ? running(seq + 1) : i < 10 ? {} : done;
    out.push(t(`p1-${i}`, { ...phase(1, 'BUILD'), ...state }));
  }
  for (let i = 0; i < 15; i++) out.push(t(`p2-${i}`, { ...phase(2, 'CHECK') }));
  out.push(t('p1-0-retry', { taskClass: 'attempt', parentTaskId: 'p1-0', status: 'failed' }));
  out.push(t('tick', { taskClass: 'bookkeeping', mode: 'planning', ...done }));
  return out;
}
