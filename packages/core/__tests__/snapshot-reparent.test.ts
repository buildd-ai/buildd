import { describe, expect, it } from 'bun:test';
import {
  applyDelta,
  entityKey,
  linearChain,
  planReparent,
  referencedKeys,
  reparentedId,
  serializeSnapshot,
  snapshotDelta,
  type V1Snapshot,
} from '../db/snapshot-reparent';
import { V1_FOLDER } from '../db/migrate-tree';

// Snapshot ids are short strings here: the kit's are UUIDs, which this repo's
// no-prod-data gate reads as row ids.
const ROOT = '0'.repeat(8) + '-0000-0000-0000-' + '0'.repeat(12);

const table = (name: string) => ({ isRlsEnabled: false, name, entityType: 'tables', schema: 'public' });
const column = (table: string, name: string, type = 'text', extra: Record<string, unknown> = {}) => ({
  type, typeSchema: null, notNull: false, dimensions: 0, default: null, generated: null, identity: null, name, entityType: 'columns', schema: 'public', table, ...extra,
});
const index = (table: string, name: string, cols: string[]) => ({
  nameExplicit: true, columns: cols.map((c) => ({ value: c, isExpression: false, asc: true, nullsFirst: false, opclass: null })), isUnique: false, where: null, with: '', method: 'btree', concurrently: false, name, entityType: 'indexes', schema: 'public', table,
});
const fk = (table: string, name: string, cols: string[], tableTo: string, colsTo: string[]) => ({
  nameExplicit: false, columns: cols, schemaTo: 'public', tableTo, columnsTo: colsTo, onUpdate: 'NO ACTION', onDelete: 'CASCADE', name, entityType: 'fks', schema: 'public', table,
});
const snap = (id: string, prevId: string, ddl: unknown[], extra: Partial<V1Snapshot> = {}): V1Snapshot => ({
  version: '8', dialect: 'postgres', id, prevIds: [prevId], ddl, renames: [], ...extra,
});

const BASE_DDL = [table('t0'), column('t0', 'id', 'uuid'), column('t0', 'v')];
const base = snap('s0', ROOT, BASE_DDL);

describe('entity identity', () => {
  it('keys an entity by type, schema, table and name; an unnamed entity by its content', () => {
    expect(entityKey(column('t0', 'v'))).toBe('columns|public|t0|v');
    expect(entityKey(table('t0'))).toBe('tables|public||t0');
    expect(entityKey({ entityType: 'odd', schema: 'public' })).toMatch(/^odd\|\{/);
  });

  it('lists the tables and columns an entity depends on', () => {
    expect(referencedKeys(column('t0', 'v'))).toEqual(['tables|public||t0']);
    expect(referencedKeys(index('t0', 'i', ['v']))).toEqual(['tables|public||t0', 'columns|public|t0|v']);
    expect(referencedKeys(fk('a', 'f', ['t0_id'], 't0', ['id']))).toEqual([
      'tables|public||a', 'tables|public||t0', 'columns|public|a|t0_id', 'columns|public|t0|id',
    ]);
    expect(referencedKeys(table('t0'))).toEqual([]);
  });
});

describe('snapshotDelta / applyDelta', () => {
  it('reads an add, a drop and an in-place alteration, and applies them where the source ordered them', () => {
    const side = snap('s1', 's0', [table('t0'), column('t0', 'id', 'uuid'), column('t0', 'v', 'text', { notNull: true }), table('a'), column('a', 'id', 'uuid')]);
    const d = snapshotDelta(base, side);
    expect([...d.removed]).toEqual([]);
    expect([...d.upserted.keys()]).toEqual(['columns|public|t0|v', 'tables|public||a', 'columns|public|a|id']);
    expect([...d.touched]).toHaveLength(3);

    const dropped = snapshotDelta(base, snap('s2', 's0', [table('t0'), column('t0', 'id', 'uuid')]));
    expect([...dropped.removed]).toEqual(['columns|public|t0|v']);

    // Applied onto a spine that gained its own entity: both orders survive.
    const spine = [table('t0'), column('t0', 'id', 'uuid'), column('t0', 'v'), table('b'), column('b', 'id', 'uuid')];
    const out = applyDelta(spine, d, side.ddl);
    expect(out.map(entityKey)).toEqual([
      'tables|public||t0', 'columns|public|t0|id', 'columns|public|t0|v', 'tables|public||a', 'columns|public|a|id', 'tables|public||b', 'columns|public|b|id',
    ]);
    expect((out[2] as { notNull: boolean }).notNull).toBe(true);
  });
});

describe('linearChain', () => {
  it('orders one side from the fork point and refuses a fork or a merge node', () => {
    const a = { folder: '20261002000000_a', snapshot: snap('sa', 's0', []) };
    const b = { folder: '20261003000000_b', snapshot: snap('sb', 'sa', []) };
    expect(linearChain([b, a], 's0')?.map((s) => s.folder)).toEqual([a.folder, b.folder]);
    expect(linearChain([a, { folder: '20261003000000_c', snapshot: snap('sc', 's0', []) }], 's0')).toBeNull();
    expect(linearChain([{ folder: '20261003000000_m', snapshot: { ...snap('sm', 's0', []), prevIds: ['s0', 'sx'] } }], 's0')).toBeNull();
    expect(linearChain([b], 's0')).toBeNull();
  });
});

describe('planReparent', () => {
  const missionA = { folder: '20261002000000_mission_a', snapshot: snap('sa', 's0', [...BASE_DDL, table('a'), column('a', 'id', 'uuid'), column('a', 't0_id', 'uuid'), fk('a', 'a_t0_fk', ['t0_id'], 't0', ['id'])]) };
  const trunkB = { folder: '20261003000000_trunk_b', snapshot: snap('sb', 's0', [...BASE_DDL, table('b'), column('b', 'id', 'uuid')]) };
  const existing = ['20261001000000_base'];
  const NOW = Date.UTC(2026, 9, 27, 12, 0, 0);

  it('disjoint changes: the mission snapshot gains trunk\'s entities, parents on trunk\'s leaf, and is named after it', () => {
    const plan = planReparent({ base, trunk: [trunkB], mission: [missionA], existingFolders: existing, nowMs: NOW });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.trunkLeaf.folder).toBe(trunkB.folder);
    expect(plan.folders).toHaveLength(1);
    const [f] = plan.folders;
    expect(f!.from).toBe(missionA.folder);
    expect(f!.to).toBe('20261027120001_mission_a');
    expect(V1_FOLDER.test(f!.to)).toBe(true);
    expect(f!.snapshot.prevIds).toEqual(['sb']);
    expect(f!.snapshot.id).not.toBe('sa');
    expect(f!.snapshot.renames).toEqual([]);
    // The union of both sides' entities, nothing lost and nothing doubled.
    const keys = f!.snapshot.ddl.map(entityKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(keys)).toEqual(new Set([...missionA.snapshot.ddl, ...trunkB.snapshot.ddl].map(entityKey)));
  });

  it('is deterministic: the same inputs give the same id, name and bytes', () => {
    const a = planReparent({ base, trunk: [trunkB], mission: [missionA], existingFolders: existing, nowMs: NOW });
    const b = planReparent({ base, trunk: [trunkB], mission: [missionA], existingFolders: existing, nowMs: NOW });
    expect(a).toEqual(b);
    expect(reparentedId('sb', 'sa')).toBe(reparentedId('sb', 'sa'));
    expect(reparentedId('sb', 'sa')).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(reparentedId('sb', 'sa')).not.toBe(reparentedId('sc', 'sa'));
  });

  it('a mission chain of two keeps two folders in order, each a second apart, chained from trunk\'s leaf', () => {
    const missionA2 = { folder: '20261002000100_mission_a2', snapshot: snap('sa2', 'sa', [...missionA.snapshot.ddl, column('a', 'note')]) };
    const plan = planReparent({ base, trunk: [trunkB], mission: [missionA2, missionA], existingFolders: existing, nowMs: NOW });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.folders.map((f) => f.to)).toEqual(['20261027120001_mission_a', '20261027120002_mission_a2']);
    expect(plan.folders[0]!.snapshot.prevIds).toEqual(['sb']);
    expect(plan.folders[1]!.snapshot.prevIds).toEqual([plan.folders[0]!.snapshot.id]);
    expect(plan.folders[1]!.snapshot.ddl.map(entityKey)).toContain('columns|public|a|note');
    expect(plan.folders[0]!.snapshot.ddl.map(entityKey)).not.toContain('columns|public|a|note');
    expect(plan.folders[1]!.snapshot.ddl.map(entityKey)).toContain('tables|public||b');
  });

  it('trunk added two: the leaf is the end of its chain and every trunk entity lands in the mission snapshot', () => {
    const trunkC = { folder: '20261004000000_trunk_c', snapshot: snap('sc', 'sb', [...trunkB.snapshot.ddl, column('b', 'c')]) };
    const plan = planReparent({ base, trunk: [trunkC, trunkB], mission: [missionA], existingFolders: existing, nowMs: NOW });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.trunkLeaf.folder).toBe(trunkC.folder);
    expect(plan.folders[0]!.snapshot.prevIds).toEqual(['sc']);
    expect(plan.folders[0]!.snapshot.ddl.map(entityKey)).toContain('columns|public|b|c');
  });

  it('new folders sort after every folder either side already has, even when the clock is behind', () => {
    const plan = planReparent({ base, trunk: [trunkB], mission: [missionA], existingFolders: ['20261101000000_future'], nowMs: NOW });
    expect(plan.ok && plan.folders[0]!.to).toBe('20261101000001_mission_a');
  });

  it('refuses when both sides changed one entity', () => {
    const trunkV = { folder: '20261003000000_trunk_v', snapshot: snap('sv', 's0', [table('t0'), column('t0', 'id', 'uuid'), column('t0', 'v', 'text', { notNull: true })]) };
    const missionV = { folder: '20261002000000_mission_v', snapshot: snap('sm', 's0', [table('t0'), column('t0', 'id', 'uuid')]) };
    const plan = planReparent({ base, trunk: [trunkV], mission: [missionV], existingFolders: existing, nowMs: NOW });
    expect(plan).toMatchObject({ ok: false, reason: 'overlap' });
    expect(!plan.ok && plan.detail).toContain('columns|public|t0|v');
  });

  it('refuses when one side\'s new entity refers to a column or table the other side changed', () => {
    const trunkDropV = { folder: '20261003000000_trunk_drop_v', snapshot: snap('sd', 's0', [table('t0'), column('t0', 'id', 'uuid')]) };
    const missionIdx = { folder: '20261002000000_mission_idx', snapshot: snap('si', 's0', [...BASE_DDL, index('t0', 't0_v_idx', ['v'])]) };
    expect(planReparent({ base, trunk: [trunkDropV], mission: [missionIdx], existingFolders: existing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'reference' });
    // The other way round too: trunk adds an fk onto a table the mission dropped.
    const missionDropT0 = { folder: '20261002000000_mission_drop', snapshot: snap('sx', 's0', []) };
    const trunkFk = { folder: '20261003000000_trunk_fk', snapshot: snap('sf', 's0', [...BASE_DDL, table('b'), column('b', 't0_id', 'uuid'), fk('b', 'b_t0', ['t0_id'], 't0', ['id'])]) };
    expect(planReparent({ base, trunk: [trunkFk], mission: [missionDropT0], existingFolders: existing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'reference' });
  });

  it('two columns on one table from different sides are disjoint, and the plan carries both', () => {
    const trunkCol = { folder: '20261003000000_trunk_col', snapshot: snap('st', 's0', [...BASE_DDL, column('t0', 'from_trunk')]) };
    const missionCol = { folder: '20261002000000_mission_col', snapshot: snap('sm', 's0', [...BASE_DDL, column('t0', 'from_mission')]) };
    const plan = planReparent({ base, trunk: [trunkCol], mission: [missionCol], existingFolders: existing, nowMs: NOW });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.folders[0]!.snapshot.ddl.map(entityKey)).toEqual(expect.arrayContaining(['columns|public|t0|from_trunk', 'columns|public|t0|from_mission']));
  });

  it('refuses renames, a forked side, a missing side and a format mismatch', () => {
    const renamed = { folder: '20261002000000_mission_r', snapshot: snap('sr', 's0', missionA.snapshot.ddl, { renames: ['public.t0.v->public.t0.w'] }) };
    expect(planReparent({ base, trunk: [trunkB], mission: [renamed], existingFolders: existing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'renames' });
    const trunkC = { folder: '20261004000000_trunk_c', snapshot: snap('sc', 's0', trunkB.snapshot.ddl) };
    expect(planReparent({ base, trunk: [trunkB, trunkC], mission: [missionA], existingFolders: existing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'chain' });
    expect(planReparent({ base, trunk: [], mission: [missionA], existingFolders: existing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'chain' });
    const v7 = { folder: '20261003000000_trunk_v7', snapshot: { ...trunkB.snapshot, version: '7' } };
    expect(planReparent({ base, trunk: [v7], mission: [missionA], existingFolders: existing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'format' });
    const notV1 = { folder: '0042_legacy', snapshot: trunkB.snapshot };
    expect(planReparent({ base, trunk: [notV1], mission: [missionA], existingFolders: existing, nowMs: NOW })).toMatchObject({ ok: false, reason: 'format' });
  });

  it('serialises the way the kit writes a snapshot file', () => {
    const plan = planReparent({ base, trunk: [trunkB], mission: [missionA], existingFolders: existing, nowMs: NOW });
    if (!plan.ok) throw new Error('expected a plan');
    const text = serializeSnapshot(plan.folders[0]!.snapshot);
    expect(text.startsWith('{\n  "version": "8",\n  "dialect": "postgres",\n  "id": "')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(['version', 'dialect', 'id', 'prevIds', 'ddl', 'renames']);
  });
});
