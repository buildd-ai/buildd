import { describe, it, expect } from 'bun:test';
import { resolveActionCardContext } from './action-card-context';
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
      href: '/app/missions/mis-1',
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
      href: '/app/missions/mis-1',
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
});
