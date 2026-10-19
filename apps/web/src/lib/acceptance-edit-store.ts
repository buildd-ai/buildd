import { db } from '@buildd/core/db';
import { missionNotes, tasks, workers } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { acceptEdits, acceptanceEditOf, pendingAcceptance } from '@buildd/spec-contract/acceptance-edit';
import { githubApi } from '@/lib/github';
import { workerOwnsPr } from '@/lib/repo-scope';
import { changedFilesForPr } from '@/lib/base-advance-notice-store';
import { syncAcceptanceEdit } from './acceptance-edit-sync';

/** Webhook entry: run on opened / reopened / synchronize. Best-effort; never throws. */
export async function flagAcceptanceEditsForPr(input: { installationId: number; repoFullName: string; prNumber: number; headSha: string }): Promise<void> {
  try {
    await syncAcceptanceEdit({ prNumber: input.prNumber, headSha: input.headSha }, {
      taskOfPr: async () => {
        const w = await db.query.workers.findFirst({
          where: sqlWhere(workerOwnsPr(input.repoFullName, input.prNumber)),
          columns: { taskId: true },
          with: { task: { columns: { id: true, missionId: true, roleSlug: true, context: true } } },
        });
        return w?.task ?? null;
      },
      changedFiles: () => changedFilesForPr(input.installationId, input.repoFullName, input.prNumber),
      saveFlag: async (taskId, flag) => {
        await db.update(tasks).set({
          context: flag
            ? sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), '{acceptanceEdit}', ${JSON.stringify(flag)}::jsonb)`
            : sql`coalesce(${tasks.context}, '{}'::jsonb) - 'acceptanceEdit'`,
        }).where(eq(tasks.id, taskId));
      },
      missionNote: async (missionId, taskId, title, body) => {
        await db.insert(missionNotes).values({ missionId, taskId, authorType: 'system', type: 'warning', title, body, actorLabel: 'acceptance-test edit' });
      },
      prComment: async (body) => {
        await githubApi(input.installationId, `/repos/${input.repoFullName}/issues/${input.prNumber}/comments`, {
          method: 'POST', body: JSON.stringify({ body }),
        });
      },
    });
  } catch (err) {
    console.error('[acceptance-edit] could not sync the flag', err instanceof Error ? err.message : err);
  }
}

/** A person accepts the flagged acceptance-test edits of a task; its test results count again. */
export async function acceptAcceptanceEdit(taskId: string, by: string): Promise<'accepted' | 'nothing_flagged'> {
  const [t] = await db.select({ context: tasks.context }).from(tasks).where(eq(tasks.id, taskId)).limit(1);
  const flag = acceptanceEditOf(t?.context);
  if (!flag || !pendingAcceptance(flag).length) return 'nothing_flagged';
  const accepted = acceptEdits(flag, by, new Date().toISOString());
  await db.update(tasks).set({
    context: sql`jsonb_set(coalesce(${tasks.context}, '{}'::jsonb), '{acceptanceEdit}', ${JSON.stringify(accepted)}::jsonb)`,
  }).where(eq(tasks.id, taskId));
  return 'accepted';
}
