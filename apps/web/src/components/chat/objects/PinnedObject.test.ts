import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { buildVisualReviewFixtureModel } from '@/lib/visual-review-model.fixtures';
import { PinnedVisualChip, pinnedObjectTitle, pinnedVisualChip } from './PinnedObject';
import { missionCountsLine } from './MissionObject';
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

describe('missionCountsLine', () => {
  const board = (over: Record<string, unknown> = {}) =>
    ({ tasks: {}, phases: [], planning: null, needsYou: [], landed: { done: 0, total: 0 }, ...over }) as unknown as MissionObjectView['board'];

  it('before any tasks exist it never reads "0 of 0"', () => {
    expect(missionCountsLine(board())).toBe('no tasks');
    expect(missionCountsLine(board({ planning: { roleName: 'Organizer' } }))).toBe('planning');
  });

  it('counts landed work once there are tasks', () => {
    expect(missionCountsLine(board({ landed: { done: 1, total: 3 } }))).toBe('1 of 3 landed');
  });
});

describe('the pinned visual review chip', () => {
  it('"Review N" (the action, the card button\'s words) when unsure screens wait on you', () => {
    const m = buildVisualReviewFixtureModel('needs_you');
    expect(pinnedVisualChip(m)).toEqual({ label: `Review ${m.summary.awaitingHuman}`, tone: 'needs' });
  });

  it('red for no browser runner', () => {
    expect(pinnedVisualChip(buildVisualReviewFixtureModel('no_browser_runner'))).toEqual({ label: 'No browser runner', tone: 'bad' });
  });

  it('nothing when there is no audit or nothing waits on you', () => {
    expect(pinnedVisualChip(null)).toBeNull();
    expect(pinnedVisualChip(buildVisualReviewFixtureModel('off'))).toBeNull();
    expect(pinnedVisualChip(buildVisualReviewFixtureModel('reviewed'))).toBeNull();
  });

  it('shows at phone width: never hidden below a breakpoint, and a real tap target', () => {
    const html = renderToStaticMarkup(createElement(PinnedVisualChip, { model: buildVisualReviewFixtureModel('needs_you'), onReview: () => {} }));
    expect(html).toContain('data-testid="canvas-pinned-visual-chip"');
    expect(html).toMatch(/Review 1/);
    expect(html).not.toMatch(/to review/);
    expect(html).not.toMatch(/class="[^"]*\bhidden\b/);
    expect(html).toMatch(/min-h-(9|10|11)/);
    expect(html).toContain('text-accent-text');
    const red = renderToStaticMarkup(createElement(PinnedVisualChip, { model: buildVisualReviewFixtureModel('no_browser_runner'), onReview: () => {} }));
    expect(red).toContain('text-status-error');
  });
});
