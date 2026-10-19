import { db } from '@buildd/core/db';
import { missions, specs, tasks, workers } from '@buildd/core/db/schema';
import { eq, inArray, sql } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { isDeliverableTask } from '@buildd/core/mission-helpers';
import { githubApi } from '@/lib/github';
import { workerOwnsPr } from '@/lib/repo-scope';
import { isUuid } from '@/lib/uuid';
import {
  acceptEdits, excludedCriteria, flagPrEdits, flagText, hasNewPending, pendingEdits,
  type AcceptanceEditsRecord, type PrFile,
} from './acceptance-test-edits';
import { livingSpecCriteriaOf, selectedScope } from './selected-scope';
import { fail, reach, type SpecCaller, type SpecError } from './store';

/** R-80, the database half: where a PR's record lives (the building task's context) and who may clear it. */

const KEY = 'acceptanceTestEdits';
const MAX_FILE_PAGES = 30;

export const recordOf = (context: unknown): AcceptanceEditsRecord | null => {
  const r = (context as Record<string, unknown> | null)?.[KEY] as AcceptanceEditsRecord | undefined;
  return r && typeof r === 'object' && Array.isArray(r.edits) && Array.isArray(r.accepted) ? r : null;
};

async function writeRecord(taskId: string, record: AcceptanceEditsRecord): Promise<void> {
  await db.update(tasks)
    .set({ context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), ${`{${KEY}}`}::text[], ${JSON.stringify(record)}::jsonb)` })
    .where(eq(tasks.id, taskId));
}

/** The mission's acceptance tests (its selected specs' `verified_by`) and the checks they cover. */
async function acceptanceOf(goalCriteria: unknown): Promise<{ paths: string[]; scope: string[] }> {
  const selected = livingSpecCriteriaOf(goalCriteria);
  if (selected.length === 0) return { paths: [], scope: [] };
  const rows = await db.select({ id: specs.id, metadata: specs.metadata }).from(specs).where(inArray(specs.id, selected.map((c) => c.specId)));
  const paths = [...new Set(rows.flatMap((r) => r.metadata?.verified_by ?? []))];
  const scope: string[] = [];
  for (const c of selected) {
    const s = await selectedScope(c);
    if (s.ok) scope.push(...s.criteria.map((r) => r.id));
  }
  return { paths, scope: [...new Set(scope)] };
}

/**
 * A PR event of a mission's building task: compare its files with the
 * mission's acceptance tests, keep the record on the task, and tell the person
 * on the PR the first time a change appears. Never throws into the webhook.
 */
export async function flagAcceptanceTestEdits(input: {
  installationId: number; repoFullName: string; prNumber: number; headSha: string; baseSha: string | null;
}, api: typeof githubApi = githubApi): Promise<AcceptanceEditsRecord | null> {
  const worker = await db.query.workers.findFirst({
    where: sqlWhere(workerOwnsPr(input.repoFullName, input.prNumber)),
    columns: { id: true },
    with: { task: { columns: { id: true, missionId: true, context: true, taskClass: true, kind: true, title: true, mode: true, creationSource: true, category: true } } },
  });
  const task = worker?.task;
  if (!task?.missionId || !isDeliverableTask(task)) return null;
  if ((task.context as Record<string, unknown> | null)?.acceptanceTests) return null;
  const mission = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, task.missionId)), columns: { goalCriteria: true } });
  const { paths, scope } = await acceptanceOf(mission?.goalCriteria);
  const prev = recordOf(task.context);
  if (paths.length === 0 && !prev) return null;

  const files: PrFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page++) {
    const batch = await api(input.installationId, `/repos/${input.repoFullName}/pulls/${input.prNumber}/files?per_page=100&page=${page}`) as PrFile[];
    files.push(...batch);
    if (batch.length < 100) break;
  }
  const next = await flagPrEdits({
    acceptancePaths: paths, scope, files, prev, prNumber: input.prNumber, headSha: input.headSha,
    readBase: async (path) => {
      if (!input.baseSha) return null;
      const f = await api(input.installationId, `/repos/${input.repoFullName}/contents/${encodeURI(path)}?ref=${input.baseSha}`);
      return typeof f?.content === 'string' ? Buffer.from(f.content, 'base64').toString('utf8') : null;
    },
  });
  if (!prev && next.edits.length === 0) return next;
  await writeRecord(task.id, next);
  if (hasNewPending(prev, next)) {
    await api(input.installationId, `/repos/${input.repoFullName}/issues/${input.prNumber}/comments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ body: flagText(next) }),
    });
  }
  return next;
}

/** Every building task's record on a mission: the mission page lists them, the fold leaves their tests out. */
export async function missionAcceptanceFlags(missionId: string): Promise<Array<{ taskId: string; title: string; record: AcceptanceEditsRecord }>> {
  const rows = await db.select({ id: tasks.id, title: tasks.title, context: tasks.context }).from(tasks).where(eq(tasks.missionId, missionId));
  return rows.flatMap((t) => { const record = recordOf(t.context); return record && record.edits.length ? [{ taskId: t.id, title: t.title, record }] : []; });
}

export async function excludedForMission(missionId: string): Promise<string[]> {
  return [...excludedCriteria((await missionAcceptanceFlags(missionId)).map((f) => f.record))];
}

/** A person accepts a building PR's change to named acceptance tests. Agents never do: that would let the work clear its own flag. */
export async function acceptTestChange(caller: SpecCaller, missionId: unknown, input: { taskId: unknown; paths: unknown }): Promise<{ ok: true; remaining: number } | SpecError> {
  if (typeof missionId !== 'string' || !isUuid(missionId)) return fail(404, 'Mission not found');
  const mission = await db.query.missions.findFirst({ where: sqlWhere(eq(missions.id, missionId)), columns: { id: true, workspaceId: true } });
  if (!mission?.workspaceId || !(await reach(caller, mission.workspaceId, false))) return fail(404, 'Mission not found');
  if (caller.kind !== 'user' && caller.account.taskScope) return fail(403, 'Accepting a changed acceptance test is a person\'s decision; a task cannot clear its own flag.');
  if (!(await reach(caller, mission.workspaceId, true))) return fail(403, 'Writing to this workspace is required to accept a changed test');
  if (typeof input.taskId !== 'string' || !isUuid(input.taskId)) return fail(400, 'taskId is required');
  if (!Array.isArray(input.paths) || input.paths.length === 0 || !input.paths.every((p) => typeof p === 'string')) return fail(400, 'paths is a list of the changed test files to accept');
  const [t] = await db.select({ missionId: tasks.missionId, context: tasks.context }).from(tasks).where(eq(tasks.id, input.taskId)).limit(1);
  const record = t?.missionId === missionId ? recordOf(t.context) : null;
  if (!record) return fail(404, 'That task has no flagged acceptance test change on this mission');
  const by = caller.kind === 'user' ? `user:${caller.userId}` : `account:${caller.account.id}`;
  const next = acceptEdits(record, input.paths as string[], by);
  if (next.accepted.length === record.accepted.length) return fail(409, 'None of those paths is a pending change on that PR');
  await writeRecord(input.taskId, next);
  return { ok: true, remaining: pendingEdits(next).length };
}
