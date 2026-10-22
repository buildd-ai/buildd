import { describe, it, expect, mock } from 'bun:test';
import { resolvePrReachGrant, resolveExplicitPrReachScope, withoutPrReachGrant } from './pr-reach-grant';

const NOW = new Date('2026-01-01T00:00:00.000Z');
const filing = (o: Record<string, unknown> = {}) => ({ title: 'resolve conflicts on #42', description: 'and land #7', context: {}, workspaceId: 'ws-1', ...o });

describe('resolvePrReachGrant', () => {
  it('a person filing links every PR the filing names', async () => {
    expect(await resolvePrReachGrant(filing({ context: { prNumber: 9 } }), { kind: 'person', personId: 'user-1' }, {}, NOW))
      .toEqual({ prNumbers: [7, 9, 42], grantedBy: 'human:user-1', grantedAt: NOW.toISOString() });
  });

  it('an agent run filing links only PRs its own task already reaches', async () => {
    const taskReachesPr = mock(async (_t: string, _w: string, n: number) => n === 42);
    expect(await resolvePrReachGrant(filing(), { kind: 'task', taskId: 'task-0' }, { taskReachesPr }, NOW))
      .toEqual({ prNumbers: [42], grantedBy: 'task:task-0', grantedAt: NOW.toISOString() });
    expect(taskReachesPr).toHaveBeenCalledWith('task-0', 'ws-1', 7);
  });

  it('an agent run naming a PR its task does not reach links nothing', async () => {
    expect(await resolvePrReachGrant(filing(), { kind: 'task', taskId: 'task-0' }, { taskReachesPr: async () => false }, NOW)).toBeNull();
  });

  it('a lookup failure links nothing', async () => {
    expect(await resolvePrReachGrant(filing(), { kind: 'task', taskId: 'task-0' }, { taskReachesPr: async () => { throw new Error('db'); } }, NOW)).toBeNull();
  });

  it('a filer that is neither a person nor a task links nothing', async () => {
    expect(await resolvePrReachGrant(filing(), { kind: 'none' }, {}, NOW)).toBeNull();
  });

  it('ignores a caller-supplied prReach as a source of PR numbers', async () => {
    const forged = { prReach: { prNumbers: [99], grantedBy: 'human:someone', grantedAt: 'x' } };
    expect(await resolvePrReachGrant(filing({ title: 'no refs', description: null, context: forged }), { kind: 'person', personId: 'user-1' }, {}, NOW)).toBeNull();
  });

  it('a filing that names no PR links nothing', async () => {
    expect(await resolvePrReachGrant(filing({ title: 'plain work', description: null }), { kind: 'person', personId: 'user-1' }, {}, NOW)).toBeNull();
  });
});

describe('withoutPrReachGrant', () => {
  it('drops prReach and keeps the rest', () => {
    expect(withoutPrReachGrant({ a: 1, prReach: { prNumbers: [1] } })).toEqual({ a: 1 });
  });
  it('leaves other shapes untouched', () => {
    const ctx = { a: 1 };
    expect(withoutPrReachGrant(ctx)).toBe(ctx);
    expect(withoutPrReachGrant(null)).toBeNull();
    expect(withoutPrReachGrant(undefined)).toBeUndefined();
  });
});

describe('resolveExplicitPrReachScope', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  it('stamps explicit PR numbers, sorted and de-duplicated', () => {
    expect(resolveExplicitPrReachScope({ prNumbers: [5, 1] }, 'human:u', now)).toEqual({
      prNumbers: [1, 5], grantedBy: 'human:u', grantedAt: now.toISOString(),
    });
  });
  it('marks a workspace-wide grant with an explicit scope, not an empty-list convention', () => {
    expect(resolveExplicitPrReachScope({ workspaceWide: true }, 'human:u', now)).toMatchObject({ prNumbers: [], scope: 'workspace' });
  });
  it('rejects malformed scopes', () => {
    for (const bad of [null, 'x', [], {}, { prNumbers: [] }, { prNumbers: [0, -1, 1.5] }, { prNumbers: ['1'] }, { workspaceWide: false }]) {
      expect(resolveExplicitPrReachScope(bad, 'human:u', now)).toBeNull();
    }
  });
});

describe('workspace-wide reach is review-only', () => {
  const ctx = { prReach: { prNumbers: [], scope: 'workspace', grantedBy: 'human:u', grantedAt: 'x' } };
  it('is held by the review door but links no PR for supersede, close or merge', async () => {
    const { taskLinksPr, taskHoldsWorkspacePrReach } = await import('./agent-capabilities/pr-links');
    expect(taskHoldsWorkspacePrReach({ context: ctx })).toBe(true);
    expect(taskLinksPr({ context: ctx }, 100)).toBe(false);
  });
  it('ignores the marker on a non-person grant or an unmarked empty list', async () => {
    const { taskHoldsWorkspacePrReach } = await import('./agent-capabilities/pr-links');
    expect(taskHoldsWorkspacePrReach({ context: { prReach: { ...ctx.prReach, grantedBy: 'task:t' } } })).toBe(false);
    expect(taskHoldsWorkspacePrReach({ context: { prReach: { prNumbers: [], grantedBy: 'human:u', grantedAt: 'x' } } })).toBe(false);
  });
});
