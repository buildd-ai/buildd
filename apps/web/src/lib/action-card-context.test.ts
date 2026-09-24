import { describe, it, expect } from 'bun:test';
import { actionCardTaskHref, actionCardTaskLink, resolveActionCardContext } from './action-card-context';
import type { ActionQueueItem } from './action-queue';

function item(partial: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return { subjectKey: 'k', chip: 'MERGE', ...partial };
}

describe('resolveActionCardContext', () => {
  it('renders initiative › mission and links to the mission', () => {
    const ctx = resolveActionCardContext(item({
      initiativeId: 'ini-1',
      initiativeTitle: 'Mobile decision flow',
      missionId: 'mis-1',
      missionTitle: 'Weekly mobile UI audit',
      workspaceName: 'buildd',
    }));
    expect(ctx).toEqual({
      kind: 'mission',
      label: 'Mobile decision flow › Weekly mobile UI audit',
      href: '/app/missions/mis-1?from=home',
    });
  });

  it('falls back to the mission alone when it has no initiative', () => {
    const ctx = resolveActionCardContext(item({
      missionId: 'mis-1',
      missionTitle: 'Health analytics restructure',
      workspaceName: 'buildd',
    }));
    expect(ctx).toEqual({
      kind: 'mission',
      label: 'Health analytics restructure',
      href: '/app/missions/mis-1?from=home',
    });
  });

  it('links to the initiative when the mission id is missing', () => {
    const ctx = resolveActionCardContext(item({
      initiativeId: 'ini-1',
      initiativeTitle: 'Mobile decision flow',
    }));
    expect(ctx).toEqual({
      kind: 'initiative',
      label: 'Mobile decision flow',
      href: '/app/initiatives/ini-1',
    });
  });

  it('renders an unlinked mission title with no href', () => {
    const ctx = resolveActionCardContext(item({ missionTitle: 'Orphan mission' }));
    expect(ctx).toEqual({ kind: 'mission', label: 'Orphan mission', href: null });
  });

  it('marks a workspace-only item as unlinked work', () => {
    const ctx = resolveActionCardContext(item({ workspaceName: '__coordination' }));
    expect(ctx).toEqual({ kind: 'workspace', label: 'No mission · __coordination', href: null });
  });

  it('returns null when there is no context at all', () => {
    expect(resolveActionCardContext(item())).toBeNull();
  });

  // docs/design/mission-feed-mobile-continuity.md: every link into a
  // mission-owned task carries the mission — the context line lands on the
  // task's row in the mission, never on a bare mission page.
  it('focuses the task row in the mission when the card names a task', () => {
    const ctx = resolveActionCardContext(item({ missionId: 'mis-1', missionTitle: 'Lease work', taskId: 't-9' }));
    expect(ctx?.href).toBe('/app/missions/mis-1?from=home#t-t-9');
  });
});

describe('actionCardTaskHref', () => {
  it('opens a mission task as the sheet over its mission', () => {
    expect(actionCardTaskHref(item({ missionId: 'mis-1', taskId: 't-9' }))).toBe('/app/missions/mis-1?from=home&task=t-9');
  });

  it('falls back to the task page for a task with no mission', () => {
    expect(actionCardTaskHref(item({ taskId: 't-9' }))).toBe('/app/tasks/t-9');
  });

  it('sends a non-row task (attempt, plan) to its full page with the mission back-link', () => {
    expect(actionCardTaskHref(item({ missionId: 'mis-1', taskId: 't-9' }), { taskId: 'retry-1', page: true }))
      .toBe('/app/tasks/retry-1?from=mission&missionId=mis-1');
  });

  it('returns null when the card names no task', () => {
    expect(actionCardTaskHref(item({ missionId: 'mis-1' }))).toBeNull();
  });
});

describe('actionCardTaskLink', () => {
  it('matches actionCardTaskHref when the card names a task', () => {
    expect(actionCardTaskLink(item({ missionId: 'mis-1', taskId: 't-9' }))).toBe('/app/missions/mis-1?from=home&task=t-9');
  });

  it('never returns null: a task-less mission card opens its mission', () => {
    expect(actionCardTaskLink(item({ missionId: 'mis-1' }))).toBe('/app/missions/mis-1?from=home');
  });

  it('never returns null: a card with neither opens the task list', () => {
    expect(actionCardTaskLink(item())).toBe('/app/tasks');
  });
});
