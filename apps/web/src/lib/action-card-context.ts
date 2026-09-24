import type { ActionQueueItem } from './action-queue';
import { missionTaskHref, taskPageHref } from './mission-task-href';

export interface ActionCardContext {
  /** Which layer of the hierarchy the label describes. */
  kind: 'mission' | 'initiative' | 'workspace';
  label: string;
  /** Where the label points, or null when the arc has no page to open. */
  href: string | null;
}

/**
 * Resolves the one context line a Waiting-on-You card shows.
 *
 * The queue is read as "which arc does this unblock", so the label walks down
 * from the widest arc the item belongs to: initiative › mission. A card with
 * neither falls back to its workspace, labelled as unlinked so an orphan PR
 * reads as a chore rather than as mission work.
 *
 * A mission label that names a task lands on that task's row in the mission
 * (`#t-<id>`, docs/design/mission-feed-mobile-continuity.md), not at the top
 * of a bare mission page.
 */
export function resolveActionCardContext(item: ActionQueueItem): ActionCardContext | null {
  const initiativeTitle = item.initiativeTitle ?? null;
  const missionTitle = item.missionTitle ?? null;

  if (missionTitle) {
    const href = !item.missionId
      ? null
      : item.taskId
        ? missionTaskHref({ missionId: item.missionId, taskId: item.taskId, from: 'home', mode: 'focus' })
        : `/app/missions/${encodeURIComponent(item.missionId)}?from=home`;
    return {
      kind: 'mission',
      label: initiativeTitle ? `${initiativeTitle} › ${missionTitle}` : missionTitle,
      href,
    };
  }

  if (initiativeTitle) {
    return {
      kind: 'initiative',
      label: initiativeTitle,
      href: item.initiativeId ? `/app/initiatives/${item.initiativeId}` : null,
    };
  }

  if (item.workspaceName) {
    return { kind: 'workspace', label: `No mission · ${item.workspaceName}`, href: null };
  }

  return null;
}

/**
 * Where a Waiting-on-You card's task link goes. A mission task opens as the
 * sheet over its mission; a task with no mission opens its own page.
 *
 * `page: true` is for a task that is not a row in the mission feed — a retry
 * attempt, a plan to approve — which opens its full page, still carrying the
 * mission back-link. `taskId` overrides the card's own task (e.g. the retry).
 */
export function actionCardTaskHref(
  item: Pick<ActionQueueItem, 'taskId' | 'missionId'>,
  opts: { taskId?: string | null; page?: boolean } = {},
): string | null {
  const taskId = opts.taskId ?? item.taskId;
  if (!taskId) return null;
  if (opts.page) return taskPageHref({ taskId, missionId: item.missionId ?? null });
  return missionTaskHref({ missionId: item.missionId ?? null, taskId, from: 'home', mode: 'sheet' });
}
