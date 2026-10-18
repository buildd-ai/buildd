/**
 * The questions waiting on a person: the shell's banner and its count
 * (components/NeedsInputProvider.tsx, via GET /api/tasks/waiting-input).
 */
import { TERMINAL_TASK_STATUSES } from '@buildd/shared';
import { db } from '@buildd/core/db';
import { tasks, workers, workspaces } from '@buildd/core/db/schema';
import { and, eq, inArray, notInArray } from 'drizzle-orm';
import { QueryBuilder } from 'drizzle-orm/pg-core';
import { userWorkspaceScope } from './team-access';
import { admitsToNeedsYou } from '@buildd/core/needs-you';
import type { WaitingFor } from '@buildd/shared';
import { loadSupersededQuestionTaskIds } from './incident-recovery-load';
import { TTLCache } from './cache';

/** More waiting questions than this is a page, not a banner. */
export const WAITING_INPUT_LIMIT = 100;
export const WAITING_INPUT_TTL_MS = 30_000;

const qb = new QueryBuilder();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Selectable = { select: (...args: any[]) => any };

export interface WaitingInputRow {
  taskId: string;
  waitingFor: unknown;
  title: string;
  status: string;
  workspaceId: string;
  missionId: string | null;
}

/**
 * The questions waiting on this user, as one statement scoped in SQL to the
 * workspaces of their teams (spec 3ef37387 R-17, R-23): waiting workers joined
 * to their open tasks. It used to read every waiting worker in the database
 * and filter by workspace afterwards.
 */
export function waitingInputQuery(userId: string, q: Selectable = db) {
  return q
    .select({
      taskId: tasks.id,
      waitingFor: workers.waitingFor,
      title: tasks.title,
      status: tasks.status,
      workspaceId: tasks.workspaceId,
      missionId: tasks.missionId,
    })
    .from(workers)
    .innerJoin(tasks, eq(tasks.id, workers.taskId))
    .where(and(
      eq(workers.status, 'waiting_input'),
      inArray(workers.workspaceId, qb.select({ id: workspaces.id }).from(workspaces).where(userWorkspaceScope(userId))),
      notInArray(tasks.status, [...TERMINAL_TASK_STATUSES]),
    ))
    .limit(WAITING_INPUT_LIMIT);
}

export interface WaitingTaskView {
  id: string;
  title: string;
  workspaceId: string;
  missionId: string | null;
  waitingFor: WaitingFor | null;
  answerSent: boolean;
  actionUrl: string;
}

const cached = new TTLCache<WaitingTaskView[]>({ maxSize: 2000, ttlMs: WAITING_INPUT_TTL_MS });

/** Tests only. */
export function clearWaitingInputCache(): void {
  cached.clear();
}

/** Pure: Needs You admission, and one row per task. */
export function waitingTaskViews(rows: WaitingInputRow[], superseded: ReadonlySet<string>, now: number): WaitingTaskView[] {
  // A worker still holding a question counts only when its disposition hands
  // it to a person (not a hold before its deadline, not a recovered blocker,
  // not undisposed). One whose answer was already sent (waitingFor cleared) is
  // kept as answerSent.
  const admitted = rows.filter(r =>
    !superseded.has(r.taskId)
    && (!r.waitingFor || admitsToNeedsYou(r.waitingFor as Record<string, unknown>, now)));
  const appBaseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
  const byTask = new Map<string, WaitingInputRow[]>();
  for (const r of admitted) byTask.set(r.taskId, [...(byTask.get(r.taskId) ?? []), r]);
  return [...byTask.values()].map(mine => {
    // A worker still holding its question wins over one already answered.
    const row = mine.find(r => r.waitingFor) ?? mine[0];
    return {
      id: row.taskId,
      title: row.title,
      workspaceId: row.workspaceId,
      // Lets the banner open the task in its mission (mission-task-href.ts).
      missionId: row.missionId ?? null,
      waitingFor: (row.waitingFor as WaitingFor | null) ?? null,
      // Answered on the resume path: `waitingFor` is cleared at once, but the
      // worker stays waiting_input until the runner resumes it. The answer is
      // on its way, so this no longer needs the person.
      answerSent: !row.waitingFor,
      actionUrl: `${appBaseUrl}/app/tasks/${row.taskId}?respond=1`,
    };
  });
}

/**
 * Kept 30 s per user. `fresh` skips the cached answer and refills it: the
 * provider asks that way only when an event says a task started or stopped
 * waiting (lib/realtime-throttle.ts needsInputEventAction).
 */
export async function loadWaitingInput(userId: string, opts: { fresh?: boolean } = {}): Promise<WaitingTaskView[]> {
  const hit = opts.fresh ? undefined : cached.get(userId);
  if (hit) return hit;
  const rows = (await waitingInputQuery(userId)) as WaitingInputRow[];
  // A question recovery has superseded (its task carries an incident ref and
  // the incident's assessment owns the next step) is not a banner or a
  // Needs You row: the incident's own status says what is happening.
  const superseded = rows.length > 0
    ? await loadSupersededQuestionTaskIds([...new Set(rows.map(r => r.taskId))])
    : new Set<string>();
  const views = waitingTaskViews(rows, superseded, Date.now());
  cached.set(userId, views);
  return views;
}
