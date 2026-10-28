/**
 * Re-parent a branch's drizzle v1 snapshots onto a trunk that moved under them,
 * without drizzle-kit and without a checkout.
 *
 * `drizzle-kit generate` writes one snapshot per migration (format v8): a flat
 * `ddl[]` of entities, each identified by its type, schema, table and name, plus
 * `id` / `prevIds`. The SQL it emits is the diff between the parent snapshot and
 * the new one. When a mission branch and trunk each generated from the same
 * parent, git merges their folders cleanly and the chain forks.
 *
 * `migrations:regenerate` repairs that by re-diffing `schema.ts` against trunk's
 * newest snapshot. Measured on this repo's own forks, its output is exactly: the
 * mission's snapshot with trunk's new entities added, parented on trunk's leaf,
 * with byte-identical SQL. That is a pure function of the three snapshots when
 * the two sides changed different objects, which is what this module computes.
 * It refuses, naming why, whenever the answer is not that function:
 *
 *  - either side touched (added, removed or altered) an entity the other side
 *    also touched (`overlap`);
 *  - one side added or altered an entity that refers to a table or column the
 *    other side removed or altered (`reference`), so its SQL could no longer
 *    apply;
 *  - either side's snapshot carries `renames` (the kit resolved a rename
 *    interactively; only a regenerate can repeat that judgement);
 *  - the two chains are not each linear from one shared parent (`chain`);
 *  - the snapshots are not the same format (`format`).
 *
 * The caller then falls back to the regenerate task. A re-parented snapshot is
 * verified by the same gates that catch a fork today: `migrations:commute`,
 * `db:generate` reporting no changes, and schema-matches-snapshot on the next
 * PR into the branch.
 *
 * No drizzle-orm import: apps/web reads this from its own bundle.
 */

import { createHash } from 'node:crypto';
import { folderMillis, formatFolderPrefix, V1_FOLDER } from './migrate-tree';

export interface V1Snapshot {
  version: string;
  dialect: string;
  id: string;
  prevIds: string[];
  ddl: unknown[];
  renames?: unknown[];
  [key: string]: unknown;
}

export interface MissionSnapshot {
  /** `<YYYYMMDDHHMMSS>_<slug>`. */
  folder: string;
  snapshot: V1Snapshot;
}

export interface ReparentInput {
  /** The fork point: the snapshot both sides' first new migration names as its parent. */
  base: V1Snapshot;
  /** Trunk's own new snapshots since `base`, any order. The leaf is found by chain. */
  trunk: MissionSnapshot[];
  /** The mission's own new snapshots since `base`, any order. */
  mission: MissionSnapshot[];
  /** Folder names on either side the new folders must sort after. */
  existingFolders: readonly string[];
  /** The clock, for folder names. Defaults to `Date.now()`. */
  nowMs?: number;
}

export interface ReparentedFolder {
  /** The mission folder this replaces. Its `migration.sql` is carried byte for byte. */
  from: string;
  /** The new folder name: trunk's leaf and the rest of the mission chain sort before it. */
  to: string;
  snapshot: V1Snapshot;
}

export type ReparentRefusal = 'format' | 'chain' | 'renames' | 'overlap' | 'reference';

export type ReparentPlan =
  | { ok: true; trunkLeaf: MissionSnapshot; folders: ReparentedFolder[] }
  | { ok: false; reason: ReparentRefusal; detail: string };

type Entity = Record<string, unknown>;

/** `<type>|<schema>|<table>|<name>`: what the kit's own diff resolvers identify an entity by. */
export function entityKey(entity: unknown): string {
  if (!entity || typeof entity !== 'object') return `?|${JSON.stringify(entity)}`;
  const e = entity as Entity;
  const s = (v: unknown) => (typeof v === 'string' ? v : '');
  if (typeof e.name !== 'string') return `${s(e.entityType)}|${JSON.stringify(entity)}`;
  return `${s(e.entityType)}|${s(e.schema)}|${s(e.table)}|${e.name}`;
}

const tableKey = (schema: unknown, table: unknown) => `tables|${typeof schema === 'string' ? schema : ''}||${typeof table === 'string' ? table : ''}`;
const columnKey = (schema: unknown, table: unknown, column: unknown) =>
  `columns|${typeof schema === 'string' ? schema : ''}|${typeof table === 'string' ? table : ''}|${typeof column === 'string' ? column : ''}`;

/** Keys of the tables and columns an entity's DDL depends on, beyond itself. */
export function referencedKeys(entity: unknown): string[] {
  if (!entity || typeof entity !== 'object') return [];
  const e = entity as Entity;
  const out: string[] = [];
  if (typeof e.table === 'string') out.push(tableKey(e.schema, e.table));
  const cols = (v: unknown): string[] =>
    Array.isArray(v)
      ? v.flatMap((c) => (typeof c === 'string' ? [c] : c && typeof c === 'object' && (c as Entity).isExpression === false && typeof (c as Entity).value === 'string' ? [(c as Entity).value as string] : []))
      : [];
  if (e.entityType === 'fks') {
    out.push(tableKey(e.schemaTo, e.tableTo));
    for (const c of cols(e.columns)) out.push(columnKey(e.schema, e.table, c));
    for (const c of cols(e.columnsTo)) out.push(columnKey(e.schemaTo, e.tableTo, c));
  } else if (e.entityType === 'indexes' || e.entityType === 'pks' || e.entityType === 'uniques') {
    for (const c of cols(e.columns)) out.push(columnKey(e.schema, e.table, c));
  }
  return out;
}

const canonical = (v: unknown): string => JSON.stringify(sortKeys(v));
function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v as Entity).sort().map((k) => [k, sortKeys((v as Entity)[k])]));
  }
  return v;
}

export interface SnapshotDelta {
  /** Keys present in `base` and absent from `side`. */
  removed: Set<string>;
  /** Keys whose entity differs between `base` and `side` (added, or altered in place), with `side`'s entity. */
  upserted: Map<string, unknown>;
  /** Every key the side changed in any way. */
  touched: Set<string>;
}

/** What `side` changed relative to `base`, by entity identity. */
export function snapshotDelta(base: V1Snapshot, side: V1Snapshot): SnapshotDelta {
  const baseBy = new Map(base.ddl.map((e) => [entityKey(e), e] as const));
  const sideBy = new Map(side.ddl.map((e) => [entityKey(e), e] as const));
  const removed = new Set<string>();
  const upserted = new Map<string, unknown>();
  for (const k of baseBy.keys()) if (!sideBy.has(k)) removed.add(k);
  for (const [k, e] of sideBy) {
    const b = baseBy.get(k);
    if (b === undefined || canonical(b) !== canonical(e)) upserted.set(k, e);
  }
  return { removed, upserted, touched: new Set([...removed, ...upserted.keys()]) };
}

/**
 * `spine` with `delta` applied. An upserted key already in the spine is replaced
 * in place; a new one is inserted right after the nearest entity that precedes
 * it in `order` and is present in the result, so each side's ordering survives.
 */
export function applyDelta(spine: readonly unknown[], delta: SnapshotDelta, order: readonly unknown[]): unknown[] {
  const result: unknown[] = spine.filter((e) => !delta.removed.has(entityKey(e)));
  const index = () => new Map(result.map((e, i) => [entityKey(e), i] as const));
  let at = index();
  for (const [k, e] of delta.upserted) {
    const existing = at.get(k);
    if (existing !== undefined) {
      result[existing] = e;
      continue;
    }
    const pos = order.findIndex((o) => entityKey(o) === k);
    let insertAt = 0;
    for (let i = pos - 1; i >= 0; i--) {
      const prev = at.get(entityKey(order[i]));
      if (prev !== undefined) { insertAt = prev + 1; break; }
    }
    result.splice(insertAt, 0, e);
    at = index();
  }
  return result;
}

/** A deterministic UUID-shaped id from what the snapshot was re-parented from and onto: a retry mints the same id. */
export function reparentedId(trunkLeafId: string, missionId: string): string {
  const h = createHash('sha256').update(`reparent:${trunkLeafId}:${missionId}`).digest('hex');
  const v = `${h.slice(0, 12)}4${h.slice(13, 16)}${(8 + (parseInt(h[16]!, 16) % 4)).toString(16)}${h.slice(17, 32)}`;
  return `${v.slice(0, 8)}-${v.slice(8, 12)}-${v.slice(12, 16)}-${v.slice(16, 20)}-${v.slice(20, 32)}`;
}

/** The snapshots of one side in chain order from `baseId`, or null when they are not one linear chain from it. */
export function linearChain(side: readonly MissionSnapshot[], baseId: string): MissionSnapshot[] | null {
  const byParent = new Map<string, MissionSnapshot[]>();
  for (const s of side) {
    if (s.snapshot.prevIds.length !== 1) return null;
    const p = s.snapshot.prevIds[0]!;
    byParent.set(p, [...(byParent.get(p) ?? []), s]);
  }
  const out: MissionSnapshot[] = [];
  let cursor = baseId;
  while (out.length < side.length) {
    const next = byParent.get(cursor);
    if (!next || next.length !== 1) return null;
    out.push(next[0]!);
    cursor = next[0]!.snapshot.id;
  }
  return out;
}

const slugOf = (folder: string) => folder.replace(/^\d{14}_/, '');

/**
 * The folders that replace the mission's, each parented on the one before it
 * and the first on trunk's leaf, with trunk's changes folded into every
 * snapshot's `ddl`. SQL is not part of the plan: it is unchanged by
 * construction, so the caller carries each `migration.sql` as it is.
 */
export function planReparent(input: ReparentInput): ReparentPlan {
  const { base, nowMs = Date.now() } = input;
  const format = (s: V1Snapshot) => `${s.version}/${s.dialect}`;
  for (const s of [...input.trunk, ...input.mission]) {
    if (!Array.isArray(s.snapshot.ddl) || !Array.isArray(s.snapshot.prevIds)) {
      return { ok: false, reason: 'format', detail: `${s.folder}: snapshot is not a drizzle v1 (v8) snapshot` };
    }
    if (format(s.snapshot) !== format(base)) {
      return { ok: false, reason: 'format', detail: `${s.folder}: snapshot format ${format(s.snapshot)} differs from the fork point's ${format(base)}` };
    }
    if (Array.isArray(s.snapshot.renames) && s.snapshot.renames.length > 0) {
      return { ok: false, reason: 'renames', detail: `${s.folder}: snapshot carries renames, which only a regenerate can re-resolve` };
    }
    if (!V1_FOLDER.test(s.folder)) return { ok: false, reason: 'format', detail: `${s.folder}: not a v1 migration folder name` };
  }
  if (input.trunk.length === 0 || input.mission.length === 0) {
    return { ok: false, reason: 'chain', detail: 'both sides must have added a migration for there to be a fork to re-parent' };
  }
  const trunk = linearChain(input.trunk, base.id);
  if (!trunk) return { ok: false, reason: 'chain', detail: `trunk's new snapshots are not one linear chain from ${base.id}` };
  const mission = linearChain(input.mission, base.id);
  if (!mission) return { ok: false, reason: 'chain', detail: `the mission's new snapshots are not one linear chain from ${base.id}` };
  const trunkLeaf = trunk[trunk.length - 1]!;

  const trunkDelta = snapshotDelta(base, trunkLeaf.snapshot);
  const missionLeafDelta = snapshotDelta(base, mission[mission.length - 1]!.snapshot);
  const overlap = [...trunkDelta.touched].filter((k) => missionLeafDelta.touched.has(k)).sort();
  if (overlap.length > 0) {
    return { ok: false, reason: 'overlap', detail: `both sides changed ${overlap.slice(0, 5).join(', ')}${overlap.length > 5 ? ` and ${overlap.length - 5} more` : ''}` };
  }
  const broken = (added: SnapshotDelta, other: SnapshotDelta): string | null => {
    for (const [k, e] of added.upserted) {
      const hit = referencedKeys(e).find((r) => other.touched.has(r));
      if (hit) return `${k} refers to ${hit}, which the other side changed`;
    }
    return null;
  };
  const reference = broken(missionLeafDelta, trunkDelta) ?? broken(trunkDelta, missionLeafDelta);
  if (reference) return { ok: false, reason: 'reference', detail: reference };

  let lastMs = Math.max(nowMs, ...[...input.existingFolders, ...input.trunk.map((t) => t.folder), ...input.mission.map((m) => m.folder)].map(folderMillis));
  let parentId = trunkLeaf.snapshot.id;
  const folders: ReparentedFolder[] = [];
  for (const m of mission) {
    // The kit names a folder to the second, so each new one is the next whole second after the last.
    lastMs = Math.floor(lastMs / 1000) * 1000 + 1000;
    const id = reparentedId(trunkLeaf.snapshot.id, m.snapshot.id);
    const { ddl: _ddl, id: _id, prevIds: _prev, renames: _renames, ...rest } = m.snapshot;
    const snapshot: V1Snapshot = {
      ...rest,
      version: m.snapshot.version,
      dialect: m.snapshot.dialect,
      id,
      prevIds: [parentId],
      ddl: applyDelta(m.snapshot.ddl, trunkDelta, trunkLeaf.snapshot.ddl),
      renames: [],
    };
    folders.push({ from: m.folder, to: `${formatFolderPrefix(lastMs)}_${slugOf(m.folder)}`, snapshot });
    parentId = id;
  }
  return { ok: true, trunkLeaf, folders };
}

/** The kit's own serialisation of a snapshot file. */
export function serializeSnapshot(snapshot: V1Snapshot): string {
  const { version, dialect, id, prevIds, ddl, renames, ...rest } = snapshot;
  return JSON.stringify({ version, dialect, id, prevIds, ddl, renames: renames ?? [], ...rest }, null, 2);
}
