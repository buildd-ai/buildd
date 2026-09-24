/**
 * Where the respond page leads (docs/design/mission-feed-mobile-continuity.md
 * W6): a mission task returns to its row on the mission, and the back link
 * names the mission, not the workspace. Pure.
 */
import { missionTaskHref, taskPageHref } from '@/lib/mission-task-href';

/** After an answer: the task where the work now is, in its mission when it has one. */
export function respondRedirectHref({ missionId, taskId }: { missionId: string | null | undefined; taskId: string | null | undefined }): string | null {
  if (!taskId) return null;
  return missionId ? missionTaskHref({ missionId, taskId, mode: 'focus' }) : taskPageHref({ taskId });
}

export function respondBackLink({
  taskId,
  mission,
  workspaceName,
}: {
  taskId: string;
  mission: { id: string; title: string } | null | undefined;
  workspaceName: string;
}): { href: string; label: string } {
  if (mission) return { href: missionTaskHref({ missionId: mission.id, taskId, mode: 'focus' }), label: mission.title };
  return { href: taskPageHref({ taskId }), label: workspaceName };
}
