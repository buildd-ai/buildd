/**
 * What a work task actually took, to sit next to its frozen estimate
 * (`./task-estimate-source.ts` writes the estimate; `./task-estimate-actuals-source.ts`
 * stores this). Pure: sessions in, numbers out.
 *
 * Agent minutes and tokens are `actualOf`, the SAME function the backtest
 * replay uses, so a live row and a replayed row measure one thing: agent
 * minutes = Σ(completedAt − startedAt) over the task's completed workers (the
 * cost measure; concurrent workers add), tokens = Σ(input + output).
 *
 * Wall time is the elapsed time a person waits: first worker start to the
 * merge. A task that merged nothing (research, a closed PR) falls back to its
 * last session's end and says so in `wallBasis`.
 *
 * Only a work task has actuals. An attempt (CI / conflict / review retry) or
 * bookkeeping task is that parent's cost: it is counted in the parent's
 * `repairs` and never scored on its own.
 */
import { actualOf, type ReplaySession } from './estimate-backtest-source';

export interface ActualsSession extends ReplaySession {
  mergedAt?: Date | string | null;
}

export interface TaskActuals {
  agentMinutes: number;
  tokens: number;
  repairs: number;
  workerCount: number;
  firstStartedAt: Date | null;
  wallMinutes: number | null;
  wallBasis: 'merge' | 'last_session' | null;
}

const ms = (d: Date | string | null | undefined) => (d ? new Date(d).getTime() : NaN);

export function computeTaskActuals(input: {
  taskClass: string | null | undefined;
  sessions: readonly ActualsSession[];
  /** Retry tasks whose parent is this task, any class. Only `attempt` ones count. */
  children?: ReadonlyArray<{ taskClass: string | null | undefined }>;
}): TaskActuals | null {
  if ((input.taskClass ?? 'work') !== 'work') return null;
  const done = input.sessions.filter(s => Number.isFinite(ms(s.startedAt)) && Number.isFinite(ms(s.completedAt)));
  const { minutes, tokens } = actualOf(done);
  if (minutes <= 0) return null;

  const first = Math.min(...done.map(s => ms(s.startedAt)));
  const lastEnd = Math.max(...done.map(s => ms(s.completedAt)));
  const merges = done.map(s => ms(s.mergedAt)).filter(Number.isFinite);
  const end = merges.length > 0 ? Math.max(...merges) : lastEnd;
  const wall = (end - first) / 60_000;

  return {
    agentMinutes: minutes,
    tokens,
    repairs: (input.children ?? []).filter(c => c.taskClass === 'attempt').length,
    workerCount: done.length,
    firstStartedAt: new Date(first),
    wallMinutes: Number.isFinite(wall) && wall > 0 ? wall : null,
    wallBasis: merges.length > 0 ? 'merge' : 'last_session',
  };
}
