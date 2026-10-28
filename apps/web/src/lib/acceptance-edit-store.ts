import { db } from '@buildd/core/db';
import { missionNotes, tasks, workers, workspaces } from '@buildd/core/db/schema';
import { eq, sql } from 'drizzle-orm';
import { sqlWhere } from '@buildd/core/db/relational-sql';
import { acceptEdits, acceptanceEditOf, pendingAcceptance } from '@buildd/spec-contract/acceptance-edit';
import { githubApi } from '@/lib/github';
import { workerOwnsPr } from '@/lib/repo-scope';
import { changedFilesForPr } from '@/lib/base-advance-notice-store';
import { acceptanceStrictnessOn, syncAcceptanceEdit } from './acceptance-edit-sync';

/** A file's text at a ref, or null where it does not exist (or is too large for the contents API). */
async function fileAt(installationId: number, repo: string, path: string, ref: string): Promise<string | null> {
  try {
    const res = await githubApi(installationId, `/repos/${repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`);
    const body = res as { content?: unknown; encoding?: unknown } | null;
    if (body && typeof body.content === 'string' && body.encoding === 'base64') return Buffer.from(body.content, 'base64').toString('utf8');
    throw new Error('contents unavailable');
  } catch (err) {
    if (err instanceof Error && /\b404\b/.test(err.message)) return null;
    throw err;
  }
}

/** Webhook entry: run on opened / reopened / synchronize. Best-effort; never throws. */
export async function flagAcceptanceEditsForPr(input: { installationId: number; repoFullName: string; prNumber: number; headSha: string }): Promise<void> {
  let workspaceId: string | null = null;
  let mergeBase: Promise<string> | undefined;
  try {
    await syncAcceptanceEdit({ prNumber: input.prNumber, headSha: input.headSha }, {
      taskOfPr: async () => {
        const w = await db.query.workers.findFirst({
          where: sqlWhere(workerOwnsPr(input.repoFullName, input.prNumber)),
          columns: { taskId: true },
          with: { task: { columns: { id: true, missionId: true, roleSlug: true, context: true, workspaceId: true } } },
        });
        workspaceId = w?.task?.workspaceId ?? null;
        return w?.task ?? null;
      },
      readSources: async (path) => {
        mergeBase ??= (async () => {
          const pr = await githubApi(input.installationId, `/repos/${input.repoFullName}/pulls/${input.prNumber}`) as { base?: { sha?: string } };
          const cmp = await githubApi(input.installationId, `/repos/${input.repoFullName}/compare/${pr.base?.sha}...${input.headSha}`) as { merge_base_commit?: { sha?: string } };
          const sha = cmp.merge_base_commit?.sha ?? pr.base?.sha;
          if (!sha) throw new Error('no merge base');
          return sha;
        })();
        const base = await mergeBase;
        return { before: await fileAt(input.installationId, input.repoFullName, path, base), after: await fileAt(input.installationId, input.repoFullName, path, input.headSha) };
      },
      strictnessOn: async () => {
        if (!workspaceId) return true;
        const [ws] = await db.select({ gitConfig: workspaces.gitConfig }).from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1);
        return acceptanceStrictnessOn(ws?.gitConfig);
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
