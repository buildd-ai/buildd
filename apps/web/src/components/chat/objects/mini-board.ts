/**
 * The compact mission board pinned inside the chat canvas: one column per
 * phase, a few rows each. Pure, so the canvas and its tests agree on which
 * rows stay in view when a phase is longer than the cap.
 */
import type { BoardStatus, BoardTask, MissionBoardModel } from '@/lib/mission-board';

export type MiniTone = 'ok' | 'live' | 'attention' | 'bad' | 'review' | 'idle';

export function miniStatusTone(status: BoardStatus): MiniTone {
  switch (status) {
    case 'merged':
    case 'done':
      return 'ok';
    case 'running':
      return 'live';
    case 'waiting':
      return 'attention';
    case 'ci_failed':
    case 'fixing':
    case 'failed':
      return 'bad';
    case 'review':
      return 'review';
    default:
      return 'idle';
  }
}

export interface MiniColumn {
  key: string;
  title: string;
  count: string;
  rows: BoardTask[];
  more: number;
}

// What needs you, then what's red, then live work, then the rest.
const PRIORITY: Record<MiniTone, number> = { attention: 0, bad: 1, live: 2, review: 3, idle: 4, ok: 5 };

export function miniBoardColumns(model: MissionBoardModel, maxRows = 5): MiniColumn[] {
  return model.phases.map(p => {
    const all = p.taskIds.map(id => model.tasks[id]).filter((t): t is BoardTask => !!t);
    // Under the cap the plan's own order reads best; over it, keep what needs you in view.
    const rows = all.length <= maxRows
      ? all
      : [...all]
        .sort((a, b) => PRIORITY[miniStatusTone(a.status)] - PRIORITY[miniStatusTone(b.status)] || p.taskIds.indexOf(a.id) - p.taskIds.indexOf(b.id))
        .slice(0, maxRows);
    return {
      key: p.key,
      title: p.label ? `${p.ordinal} ${p.label}` : `Phase ${p.ordinal}`,
      count: `${p.done}/${p.total}`,
      rows,
      more: Math.max(0, all.length - rows.length),
    };
  });
}
