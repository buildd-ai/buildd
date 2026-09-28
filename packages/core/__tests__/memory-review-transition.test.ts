/**
 * Dashboard review actions on a memory (promote / dismiss / reverified).
 *
 * Invariants:
 * - The store's UPDATE is bound to the team AND the project, and re-checks
 *   the starting state, so a stale page or a foreign id changes nothing.
 * - A promotion applies the row's deferred supersedes inside the same team
 *   and project, and the write path flips them in the index.
 * - The pure rules agree with the SQL about which rows each action takes.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const dialect = new PgDialect();
const updates: Array<{ set: Record<string, unknown>; where: unknown }> = [];
let returningQueue: Array<Array<Record<string, unknown>>> = [];

const row = (over: Record<string, unknown> = {}) => ({
  id: 'mem-1', teamId: 'team-a', type: 'gotcha', title: 'T', content: 'C', project: 'acme/widgets',
  tags: [], files: [], source: null, supersededBy: null, state: 'active', sourceKind: null, sourceId: null,
  external: false, validFrom: null, invalidatedAt: null, reverifyFlaggedAt: null, reverifyRef: null,
  corroboratedBy: null, pendingSupersedes: [], createdAt: new Date(0), updatedAt: new Date(0), ...over,
});

mock.module('../db', () => ({
  db: {
    update: () => ({
      set: (set: Record<string, unknown>) => ({
        where: (where: unknown) => {
          updates.push({ set, where });
          return { returning: async () => returningQueue.shift() ?? [] };
        },
      }),
    }),
  },
}));

const { MemoryStore } = await import('../memory-store');
const { transitionMemory } = await import('../memory-write');
const { memoryReviewActionAllowed, memoryDisplayStateOf, isMemoryReviewAction } = await import('../memory-candidates');

const sqlOf = (w: unknown) => dialect.sqlToQuery(w as any);

beforeEach(() => { updates.length = 0; returningQueue = []; });

describe('MemoryStore.transition', () => {
  it('promote: candidate to active, bound to team, project and state', async () => {
    returningQueue = [[row({ state: 'active' })]];
    const res = await new MemoryStore('team-a').transition('mem-1', 'Acme/Widgets', 'promote');
    expect(res?.memory.state).toBe('active');
    expect(updates[0].set).toMatchObject({ state: 'active' });
    expect(updates[0].set.validFrom).toBeInstanceOf(Date);
    const q = sqlOf(updates[0].where);
    expect(q.sql).toContain('"memories"."team_id" = $');
    expect(q.sql).toContain('"memories"."project" = $');
    expect(q.sql).toContain('"memories"."superseded_by" is null');
    expect(q.sql).toContain('"memories"."state" in ($');
    expect(q.params).toEqual(expect.arrayContaining(['mem-1', 'team-a', 'acme/widgets', 'candidate']));
    expect(q.params).not.toContain('active');
  });

  it('dismiss: to invalidated from candidate, active or expired; clears the re-verify flag', async () => {
    returningQueue = [[row({ state: 'invalidated' })]];
    await new MemoryStore('team-a').transition('mem-1', 'acme/widgets', 'dismiss');
    expect(updates[0].set).toMatchObject({ state: 'invalidated', reverifyFlaggedAt: null, reverifyRef: null });
    expect(updates[0].set.invalidatedAt).toBeInstanceOf(Date);
    const q = sqlOf(updates[0].where);
    expect(q.params).toEqual(expect.arrayContaining(['candidate', 'active', 'expired']));
    expect(q.params).not.toContain('invalidated');
  });

  it('reverified: clears the flag only, and only on a flagged row', async () => {
    returningQueue = [[row()]];
    await new MemoryStore('team-a').transition('mem-1', 'acme/widgets', 'reverified');
    expect(updates[0].set).toMatchObject({ reverifyFlaggedAt: null, reverifyRef: null });
    expect(updates[0].set.state).toBeUndefined();
    expect(sqlOf(updates[0].where).sql).toContain('"memories"."reverify_flagged_at" is not null');
  });

  it('returns null when the guarded UPDATE matched nothing', async () => {
    returningQueue = [[]];
    expect(await new MemoryStore('team-a').transition('mem-1', 'acme/widgets', 'promote')).toBeNull();
    expect(updates).toHaveLength(1);
  });

  it('writes nothing without a project key', async () => {
    expect(await new MemoryStore('team-a').transition('mem-1', '  ', 'promote')).toBeNull();
    expect(updates).toHaveLength(0);
  });

  it('promote applies deferred supersedes in the same team and project, then clears the list', async () => {
    returningQueue = [
      [row({ state: 'active', pendingSupersedes: ['old-1', 'mem-1'] })],
      [{ id: 'old-1' }],
      [row({ state: 'active', pendingSupersedes: [] })],
    ];
    const res = await new MemoryStore('team-a').transition('mem-1', 'acme/widgets', 'promote');
    expect(res?.supersededIds).toEqual(['old-1']);
    expect(res?.memory.pendingSupersedes).toEqual([]);
    expect(updates).toHaveLength(3);
    expect(updates[1].set).toMatchObject({ supersededBy: 'mem-1' });
    const q = sqlOf(updates[1].where);
    expect(q.params).toEqual(expect.arrayContaining(['team-a', 'acme/widgets', 'old-1']));
    expect(updates[2].set).toEqual({ pendingSupersedes: [] });
  });

  it('dismiss never applies deferred supersedes', async () => {
    returningQueue = [[row({ state: 'invalidated', pendingSupersedes: ['old-1'] })]];
    const res = await new MemoryStore('team-a').transition('mem-1', 'acme/widgets', 'dismiss');
    expect(res?.supersededIds).toEqual([]);
    expect(updates).toHaveLength(1);
  });
});

describe('transitionMemory', () => {
  it('mirrors the row and flips what the promotion superseded', async () => {
    const upserts: any[] = [];
    const store = {
      async upsert(ns: string, chunks: any[]) { upserts.push({ ns, chunks }); return { inserted: 1, updated: 0, superseded: 1 }; },
      async query() { return []; }, async delete() {}, async listNamespaces() { return []; },
    };
    const client = { transition: async () => ({ memory: { ...row(), createdAt: '', updatedAt: '', validFrom: null } as any, supersededIds: ['old-1'] }) };
    const res = await transitionMemory(client, 'mem-1', 'acme/widgets', 'promote', { teamId: 'team-a', knowledgeStore: store as any, via: 'dashboard:review' });
    expect(res?.supersededIds).toEqual(['old-1']);
    expect(res?.mirrored).toBe(true);
    expect(upserts[0].ns).toBe('team-a:memory');
    expect(upserts[0].chunks[0].supersedes).toEqual(['old-1']);
  });

  it('returns null and mirrors nothing when the store changed nothing', async () => {
    const upserts: any[] = [];
    const store = { async upsert(...a: any[]) { upserts.push(a); return null; } } as any;
    const res = await transitionMemory({ transition: async () => null }, 'mem-1', 'acme/widgets', 'dismiss', { teamId: 'team-a', knowledgeStore: store, via: 'dashboard:review' });
    expect(res).toBeNull();
    expect(upserts).toHaveLength(0);
  });
});

describe('review rules', () => {
  it('display state: superseded wins over the state column', () => {
    expect(memoryDisplayStateOf({ state: 'active', supersededBy: 'x' })).toBe('superseded');
    expect(memoryDisplayStateOf({ state: 'candidate' })).toBe('candidate');
    expect(memoryDisplayStateOf({})).toBe('active');
  });

  it('which rows each action takes', () => {
    expect(memoryReviewActionAllowed('promote', { state: 'candidate' })).toBe(true);
    expect(memoryReviewActionAllowed('promote', { state: 'active' })).toBe(false);
    expect(memoryReviewActionAllowed('dismiss', { state: 'active' })).toBe(true);
    expect(memoryReviewActionAllowed('dismiss', { state: 'invalidated' })).toBe(false);
    expect(memoryReviewActionAllowed('reverified', { state: 'active' })).toBe(false);
    expect(memoryReviewActionAllowed('reverified', { state: 'active', reverifyFlaggedAt: '2026-01-01' })).toBe(true);
    expect(memoryReviewActionAllowed('dismiss', { state: 'candidate', supersededBy: 'x' })).toBe(false);
  });

  it('parses only known actions', () => {
    expect(isMemoryReviewAction('promote')).toBe(true);
    expect(isMemoryReviewAction('delete')).toBe(false);
    expect(isMemoryReviewAction(undefined)).toBe(false);
  });
});
