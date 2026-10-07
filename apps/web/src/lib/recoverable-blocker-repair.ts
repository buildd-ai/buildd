/**
 * Files (or reuses) the repair task for a recoverable blocker an agent tried
 * to ask a person about (stage 0 of lib/question-gate-check.ts). The "what" —
 * classification, title, description, signature — is pure in
 * `@buildd/core/human-attention`; this is only the filing, in the shape of the
 * other server-side filers (lib/experiment-cleanup-task.ts).
 *
 * Dedupe: one live repair per signature (blocker kind × mission or workspace).
 * A second blocked task reuses it, and the signature is also a system
 * subject anchor, so the API's own dedupe collapses a hand-filed duplicate onto
 * it. The check-then-insert race only costs a second repair task.
 *
 * Never load-bearing: a null return makes the gate fall through to asking.
 */
import { after } from 'next/server';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { extractSubjectAnchor } from '@buildd/core/subject-anchor-extractor';
import { projectSubjectAnchor } from '@buildd/core/subject-anchor-observe';
import { announceTaskCreated, wakeTask } from '@/lib/dispatch-authority';
import { pickEffectiveRole } from '@/lib/effective-roles';
import type { FileRepairInput } from './question-gate-check';

export async function fileRecoverableBlockerRepair(input: FileRepairInput): Promise<{ id: string; reused: boolean } | null> {
  const { workspaceId, missionId, blockedTaskId, spec } = input;
  try {
    const [live] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(
        eq(tasks.workspaceId, workspaceId),
        eq(tasks.subjectErrorSignature, spec.signature),
        inArray(tasks.status, ['pending', 'assigned', 'in_progress']),
      ))
      .limit(1);
    if (live?.id) return { id: live.id, reused: true };

    const anchor = extractSubjectAnchor({ systemContext: { origin: 'watcher', errorSignature: spec.signature } }).anchor;
    const roleSlug = await pickEffectiveRole(workspaceId, ['builder']);
    const [task] = await db
      .insert(tasks)
      .values({
        workspaceId,
        missionId,
        title: spec.title,
        description: spec.description,
        status: 'pending',
        mode: 'execution',
        category: 'bug',
        roleSlug,
        priority: 5,
        creationSource: 'webhook',
        context: { type: 'recoverable_blocker_repair', blockedTaskIds: [blockedTaskId] },
        ...(anchor ? projectSubjectAnchor(anchor) : {}),
      })
      .returning({ id: tasks.id });
    if (!task?.id) return null;

    // After the response: the runner gives the whole gate a few seconds and a
    // timeout there would page a person anyway. The row is claimable on the next
    // poll whether or not this fan-out runs.
    const taskId = task.id;
    const dispatch = async () => {
      try {
        const [workspace] = await db
          .select({
            id: workspaces.id, name: workspaces.name, repo: workspaces.repo, webhookConfig: workspaces.webhookConfig,
            githubInstallationId: workspaces.githubInstallationId, githubRepoId: workspaces.githubRepoId,
          })
          .from(workspaces)
          .where(eq(workspaces.id, workspaceId))
          .limit(1);
        await announceTaskCreated({ id: taskId, title: spec.title, description: spec.description, workspaceId }, workspace ?? { id: workspaceId });
        await wakeTask(taskId, 'task.created');
      } catch (err) {
        console.error('[recoverable-blocker] dispatch failed:', err);
      }
    };
    try { after(dispatch); } catch { await dispatch(); }
    return { id: task.id, reused: false };
  } catch (err) {
    console.error('[recoverable-blocker] filing failed:', err);
    return null;
  }
}
