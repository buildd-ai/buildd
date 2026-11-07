import { describe, expect, it } from 'bun:test';
import {
  describeAccessGaps, findAccessGaps, inheritTaskDelegation, parseTaskAccessInput, readAccessNeeds,
  readScheduleDelegation, readTaskAccessGrants, stampTaskAccess, taskAccessCovers, withTaskAccess,
  ACCESS_NEEDS_CONTEXT_KEY, TASK_ACCESS_MAX, type TaskDelegation,
} from '../token-delegation';

const WS = '00000000-0000-4000-8000-000000000002';

describe('parseTaskAccessInput (access declared at filing)', () => {
  it('takes request_capability vocabulary: provider + access read + reason, deduped by provider', () => {
    expect(parseTaskAccessInput([
      { provider: 'Neon', access: 'read', reason: ' count failed runs ' },
      { provider: 'neon', access: 'read' },
      { provider: 'axiom', access: 'read' },
    ])).toEqual({ ok: true, needs: [
      { provider: 'neon', access: 'read', reason: 'count failed runs' },
      { provider: 'axiom', access: 'read', reason: null },
    ] });
    expect(parseTaskAccessInput(undefined)).toEqual({ ok: true, needs: [] });
  });

  it('a write is refused, never dropped: a person decides each write on the run', () => {
    const r = parseTaskAccessInput([{ provider: 'neon', access: 'write', reason: 'fix rows' }]);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('never granted at filing');
  });

  it('refuses malformed entries, buildd itself, model.inference and long lists', () => {
    for (const bad of [
      'neon', [{ provider: 'neon' }], [{ provider: 'neon', access: 'admin' }], [{ provider: 'Not A Slug!', access: 'read' }],
      [{ provider: 'neon', access: 'read', connectorId: 'x' }], [{ provider: 'buildd', access: 'read' }],
      [{ provider: 'model.inference', access: 'read' }],
      Array.from({ length: TASK_ACCESS_MAX + 1 }, (_, i) => ({ provider: `p${i}`, access: 'read' })),
    ]) {
      expect(parseTaskAccessInput(bad).ok).toBe(false);
    }
  });

  it('needs are read from context defensively', () => {
    expect(readAccessNeeds({ [ACCESS_NEEDS_CONTEXT_KEY]: [{ provider: 'neon', access: 'read' }] })).toEqual([{ provider: 'neon', access: 'read', reason: null }]);
    expect(readAccessNeeds({ [ACCESS_NEEDS_CONTEXT_KEY]: [{ provider: 'neon', access: 'write' }] })).toEqual([]);
    expect(readAccessNeeds(null)).toEqual([]);
  });
});

describe('filed grants', () => {
  const grants = stampTaskAccess([{ provider: 'neon', access: 'read', reason: 'r' }], 'user-1', new Date('2026-01-01T00:00:00Z'));

  it('cover a read of that provider, never a write or another provider', () => {
    expect(taskAccessCovers(grants, 'neon', 'read')?.grantedByUserId).toBe('user-1');
    expect(taskAccessCovers(grants, 'neon', 'write')).toBeNull();
    expect(taskAccessCovers(grants, 'axiom', 'read')).toBeNull();
  });

  it('live on the delegation next to workspace grants, and clearing one keeps the other', () => {
    const current: TaskDelegation = { grants: [{ workspaceId: WS, capabilities: ['tasks:create'] }], grantedByUserId: 'u0', grantedByAccountId: null, grantedAt: '2026-01-01T00:00:00Z' };
    const withAccess = withTaskAccess(current, grants, { userId: 'user-1' })!;
    expect(readTaskAccessGrants(withAccess)).toEqual(grants);
    expect(readScheduleDelegation(withAccess)).toEqual(current.grants);
    const cleared = withTaskAccess(withAccess, [], { userId: 'user-1' })!;
    expect(cleared.access).toBeUndefined();
    expect(cleared.grants).toEqual(current.grants);
    expect(withTaskAccess(null, [], { userId: 'u' })).toBeNull();
    expect(withTaskAccess(null, grants, { userId: 'u' })!.grants).toEqual([]);
  });

  it('a stored grant without a person is no grant', () => {
    expect(readTaskAccessGrants({ access: [{ provider: 'neon', access: 'read' }] })).toEqual([]);
    expect(readTaskAccessGrants({ access: [{ provider: 'neon', access: 'write', grantedByUserId: 'u' }] })).toEqual([]);
  });

  it('a retry inherits them, even with no workspace grants', () => {
    const inherited = inheritTaskDelegation({ id: 'task-parent', delegation: withTaskAccess(null, grants, { userId: 'user-1' }) });
    expect(inherited?.access).toEqual(grants);
    expect(inherited?.inheritedFromTaskId).toBe('task-parent');
  });
});

describe('findAccessGaps', () => {
  const needs = [{ provider: 'neon', access: 'read' as const, reason: 'counts' }, { provider: 'axiom', access: 'read' as const, reason: null }];
  it('a need is met by a filed grant or a policy that auto-grants it; anything else is a gap', () => {
    const grants = stampTaskAccess([needs[0]], 'u');
    expect(findAccessGaps(needs, grants, () => false).map(g => g.provider)).toEqual(['axiom']);
    expect(findAccessGaps(needs, [], p => p === 'neon').map(g => g.provider)).toEqual(['axiom']);
    expect(findAccessGaps(needs, grants, () => true)).toEqual([]);
    expect(describeAccessGaps([needs[0]])).toContain('neon read');
  });
});
