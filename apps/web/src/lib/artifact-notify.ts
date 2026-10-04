/**
 * Push notification when artifacts are created for human review.
 *
 * Artifacts meant for human review (reports, analyses, recommendations) generate
 * a push to the team's notification channel so review tasks don't get forgotten.
 * Opt-in per task via context.notifyOnArtifact, with default on for schedule-spawned
 * tasks that set it in their template.
 */

import { db } from '@buildd/core/db';
import { tasks, workspaces } from '@buildd/core/db/schema';
import { eq } from 'drizzle-orm';
import { isReviewArtifact } from './artifact-prominence';
import { notifyTeamOf, type NotifyPayload } from './notify';
import type { Artifact } from '@buildd/core/db/schema';

/**
 * Determine if an artifact should trigger a notification.
 *
 * Requirements:
 * 1. The artifact must be meant for human review (isReviewArtifact)
 * 2. The task that produced it must exist
 * 3. The task context must explicitly set notifyOnArtifact=true
 */
export async function shouldNotifyOnArtifact(
  artifact: Artifact,
  taskId?: string | null
): Promise<boolean> {
  // Only notify for artifacts meant for review.
  if (!isReviewArtifact(artifact)) return false;

  // Need a task to check for the opt-in flag.
  if (!taskId) return false;

  try {
    const task = await db.query.tasks.findFirst({
      where: eq(tasks.id, taskId),
      columns: { context: true, workspaceId: true },
    });

    if (!task) return false;

    const ctx = task.context && typeof task.context === 'object'
      ? (task.context as Record<string, unknown>)
      : {};

    return Boolean(ctx.notifyOnArtifact);
  } catch (err) {
    console.error('[artifact-notify] Error checking shouldNotifyOnArtifact:', err);
    return false;
  }
}

/**
 * Send a push notification that an artifact is ready for review.
 *
 * Constructs a deep link to the artifact in the task page and notifies the team
 * that owns the workspace. Fire-and-forget: failures are swallowed.
 */
export async function notifyArtifactReady(
  artifact: Artifact,
  taskId: string,
  workspaceId: string
): Promise<void> {
  try {
    // Construct the deep link to the artifact within the task
    const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://buildd.dev';
    const artifactUrl = `${baseUrl}/app/tasks/${taskId}?artifact=${artifact.id}`;

    const payload: NotifyPayload = {
      title: `Artifact ready: ${artifact.title}`,
      message: `A ${artifact.type} artifact is ready for review.`,
      url: artifactUrl,
      urlTitle: 'View artifact',
      priority: -1, // Silent notification; user can see it when checking tasks
    };

    await notifyTeamOf(
      { workspaceId },
      'artifactReady',
      payload
    );
  } catch (err) {
    // Non-fatal: notifications must never block artifact creation.
    console.error('[artifact-notify] Failed to notify on artifact:', err instanceof Error ? err.message : 'unknown');
  }
}
