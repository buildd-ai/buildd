import { describe, expect, it } from 'bun:test';
import { pinnedObjectTitle } from './PinnedObject';
import type { BuilddObjectRef } from '../chat-contract';
import type { MissionObjectView, TaskObjectView } from './object-views';

const taskRef: BuilddObjectRef = { kind: 'task', id: 't1', workspaceId: 'ws', fallbackText: 'This task' };
const missionRef: BuilddObjectRef = { kind: 'mission', id: 'm1', workspaceId: 'ws', fallbackText: 'This mission' };

const taskView = (over: Partial<TaskObjectView> = {}): TaskObjectView => ({
  kind: 'task', id: 't1', workspaceId: 'ws', title: 'feat(fx): rates service with a cache', scope: 'fx', label: 'rates service with a cache',
  status: 'running', roleName: null, roleColor: null, missionId: null, missionTitle: null, worker: null, now: null, renderedAt: 0, ...over,
});

describe('pinnedObjectTitle', () => {
  it('a loaded task shows its display label (scope-stripped), not the raw conventional-commit title', () => {
    expect(pinnedObjectTitle(taskRef, taskView())).toBe('rates service');
  });

  it('a loaded task with a bracketed re-run title still resolves through taskDisplayLabel', () => {
    expect(pinnedObjectTitle(taskRef, taskView({ title: '[CI Retry] fix(claim): tighten the overlap gate' }))).toBe('tighten overlap gate');
  });

  it('a loaded mission shows its own title as-is', () => {
    const view: MissionObjectView = {
      kind: 'mission', id: 'm1', workspaceId: 'ws', title: 'Multi-currency invoices', goal: null, status: 'active',
      stateLabel: 'running', workspaceName: null, board: { tasks: {}, phases: [], planning: null } as MissionObjectView['board'], renderedAt: 0,
    };
    expect(pinnedObjectTitle(missionRef, view)).toBe('Multi-currency invoices');
  });

  it('before the object loads, falls back to the ref (never a raw, unlabeled title)', () => {
    expect(pinnedObjectTitle(taskRef, null)).toBe('This task');
    expect(pinnedObjectTitle(missionRef, null)).toBe('This mission');
  });
});
