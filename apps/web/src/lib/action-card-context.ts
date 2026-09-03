import type { ActionQueueItem } from './action-queue';

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
 */
export function resolveActionCardContext(item: ActionQueueItem): ActionCardContext | null {
  const initiativeTitle = item.initiativeTitle ?? null;
  const missionTitle = item.missionTitle ?? null;

  if (missionTitle) {
    return {
      kind: 'mission',
      label: initiativeTitle ? `${initiativeTitle} › ${missionTitle}` : missionTitle,
      href: item.missionId ? `/app/missions/${item.missionId}` : null,
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
