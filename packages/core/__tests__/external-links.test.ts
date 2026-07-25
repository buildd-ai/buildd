import { describe, it, expect } from 'bun:test';
import { linkExternal, getLinksForEntity, findLinkByExternal } from '../external-links';
import { externalLinks } from '../db/schema';

// These tests assert the helpers' OBSERVABLE CONTRACT via a recording mock db —
// the plain values passed to .values()/.set(), the conflict target identity, and
// that a where/targetWhere predicate was built. They deliberately do NOT introspect
// drizzle-orm's query AST: 90+ apps/web tests globally `mock.module('drizzle-orm')`,
// and bun's mock.module is global + persistent (keyed by resolved path), so in a
// full-suite run drizzle's real internals are frequently replaced with stubs. Asserting
// on captured args (not AST internals) keeps this test robust either way. The exact
// SQL predicate (`external_id IS NOT NULL`) is enforced structurally by the partial
// unique index in the migration. See MEMORY bun-mock-module-cross-file-leak.

const TEAM = 'aaaaaaaa-0000-0000-0000-000000000001';
const ENTITY = 'bbbbbbbb-0000-0000-0000-000000000002';

// ── mock db builders (record the args they receive) ─────────────────────────

function makeInsertDb(returnRows: any[]) {
  const calls: any = {};
  const builder: any = {
    values(v: any) { calls.values = v; return builder; },
    onConflictDoUpdate(cfg: any) { calls.onConflict = cfg; return builder; },
    returning() { calls.returningCalled = true; return Promise.resolve(returnRows); },
  };
  const db: any = { insert(table: any) { calls.table = table; return builder; } };
  return { db, calls };
}

function makeSelectDb(returnRows: any[], withLimit: boolean) {
  const calls: any = {};
  const builder: any = {
    from(table: any) { calls.table = table; return builder; },
    where(w: any) {
      calls.where = w;
      return withLimit ? builder : Promise.resolve(returnRows);
    },
    limit(n: number) { calls.limit = n; return Promise.resolve(returnRows); },
  };
  const db: any = { select() { return builder; } };
  return { db, calls };
}

// ── linkExternal ─────────────────────────────────────────────────────────────

describe('linkExternal', () => {
  const input = {
    teamId: TEAM,
    provider: 'linear' as const,
    builddEntityType: 'mission' as const,
    builddEntityId: ENTITY,
    externalId: 'proj_123',
    externalUrl: 'https://linear.app/acme/project/proj-123',
    externalUpdatedAt: new Date('2026-07-25T00:00:00Z'),
  };

  it('inserts into external_links with all provided values', async () => {
    const { db, calls } = makeInsertDb([{ id: 'row-1' }]);
    await linkExternal(db, input);
    expect(calls.table).toBe(externalLinks);
    expect(calls.values).toMatchObject({
      teamId: TEAM,
      provider: 'linear',
      builddEntityType: 'mission',
      builddEntityId: ENTITY,
      externalId: 'proj_123',
      externalUrl: input.externalUrl,
      externalUpdatedAt: input.externalUpdatedAt,
    });
  });

  it('defaults optional url/watermark to null when omitted', async () => {
    const { db, calls } = makeInsertDb([{ id: 'row-1' }]);
    await linkExternal(db, {
      teamId: TEAM,
      provider: 'linear',
      builddEntityType: 'mission',
      builddEntityId: ENTITY,
      externalId: 'proj_123',
    });
    expect(calls.values.externalUrl).toBeNull();
    expect(calls.values.externalUpdatedAt).toBeNull();
  });

  it('upserts on the (provider, externalId) partial-unique index', async () => {
    const { db, calls } = makeInsertDb([{ id: 'row-1' }]);
    await linkExternal(db, input);
    // Conflict target must be exactly the two index columns, in order (identity-robust:
    // helper and test read the same schema module, mocked or not).
    expect(calls.onConflict.target).toEqual([externalLinks.provider, externalLinks.externalId]);
    // A targetWhere predicate must be passed so the arbiter resolves against the partial
    // index (its exact SQL is asserted structurally by the migration, not here).
    expect(calls.onConflict.targetWhere).toBeDefined();
  });

  it('updates url/watermark and bumps updated_at on conflict', async () => {
    const { db, calls } = makeInsertDb([{ id: 'row-1' }]);
    await linkExternal(db, input);
    expect(calls.onConflict.set.externalUrl).toBe(input.externalUrl);
    expect(calls.onConflict.set.externalUpdatedAt).toBe(input.externalUpdatedAt);
    // updatedAt is bumped (to NOW()) on conflict — a value is always passed.
    expect(calls.onConflict.set.updatedAt).toBeDefined();
  });

  it('returns the upserted row from .returning()', async () => {
    const { db, calls } = makeInsertDb([{ id: 'row-1', externalId: 'proj_123' }]);
    const row = await linkExternal(db, input);
    expect(calls.returningCalled).toBe(true);
    expect(row).toEqual({ id: 'row-1', externalId: 'proj_123' });
  });
});

// ── getLinksForEntity ─────────────────────────────────────────────────────────

describe('getLinksForEntity', () => {
  it('selects from external_links filtered by entity type + id', async () => {
    const rows = [{ id: 'row-1' }, { id: 'row-2' }];
    const { db, calls } = makeSelectDb(rows, false);
    const result = await getLinksForEntity(db, 'mission', ENTITY);
    expect(calls.table).toBe(externalLinks);
    expect(calls.where).toBeDefined(); // filtered by (builddEntityType, builddEntityId)
    expect(result).toEqual(rows);
  });
});

// ── findLinkByExternal ──────────────────────────────────────────────────────

describe('findLinkByExternal', () => {
  it('selects the single row by (provider, externalId)', async () => {
    const { db, calls } = makeSelectDb([{ id: 'row-1' }], true);
    const row = await findLinkByExternal(db, 'linear', 'proj_123');
    expect(calls.table).toBe(externalLinks);
    expect(calls.where).toBeDefined(); // filtered by (provider, externalId)
    expect(calls.limit).toBe(1);
    expect(row).toEqual({ id: 'row-1' });
  });

  it('returns null when no row matches', async () => {
    const { db } = makeSelectDb([], true);
    const row = await findLinkByExternal(db, 'linear', 'missing');
    expect(row).toBeNull();
  });
});
