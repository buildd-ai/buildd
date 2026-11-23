/**
 * The schema a drizzle v1 migrations folder describes, as a full `ddl[]`.
 *
 * Up to drizzle-kit 1.0.0-rc.4 (snapshot format 8) every `snapshot.json` held the
 * whole schema, so the drift gate read the newest one. From rc.6 (format 10) only
 * the first migration holds a **base** snapshot; every later one is a **diff**
 * snapshot of deltas. The schema at any migration exists only once drizzle-kit
 * replays base + deltas, which is what its `reconstruct()` does, with the
 * installed version.
 *
 * A folder can have several leaves (two branches each generated from one base and
 * nothing merged them; v1 allows this, and `drizzle-kit check` proves the branches
 * commute). `reconstruct()` refuses to pick one, so this reconstructs every leaf
 * and returns their union, each entity once: the same rule the gate used for
 * format-8 leaves (`unionLeafDdl`).
 *
 * Kept out of migrate-drift.ts on purpose: that module is pure and imported from
 * app code, and drizzle-kit is a dev dependency of @buildd/core.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { loadSnapshotMetasV1, snapshotLeaves, unionLeafDdl } from './migrate-drift';

export interface ReconstructedSchema {
  /** `{ version, dialect, ddl }`, the shape `expectedColumnsFromSnapshot` reads. */
  snapshot: { version: string; dialect: 'postgres'; ddl: unknown[] };
  /** `<folder>/snapshot.json` of every leaf that went into the union. */
  leaves: string[];
}

export async function reconstructSchemaDdl(drizzleDir: string): Promise<ReconstructedSchema> {
  const metas = loadSnapshotMetasV1(drizzleDir);
  if (metas.length === 0) throw new Error(`No snapshot files found in ${drizzleDir}`);

  const files: Record<string, unknown> = {};
  for (const m of metas) files[m.file] = JSON.parse(readFileSync(join(drizzleDir, m.file), 'utf8'));

  // drizzle-kit loads its dialect payload lazily; importing at call time keeps
  // this module cheap to import for callers that only type against it.
  const { reconstruct } = await import('drizzle-kit/api-postgres');

  const leaves = snapshotLeaves(metas);
  const byFile = new Map<string, unknown[]>();
  let version = '';
  for (const leaf of leaves) {
    const state = await reconstruct(files, leaf.id);
    version = String(state.version);
    byFile.set(leaf.file, state.ddl as unknown[]);
  }
  const ddl = unionLeafDdl(leaves, (file) => byFile.get(file) ?? []);
  return { snapshot: { version, dialect: 'postgres', ddl }, leaves: leaves.map((l) => l.file) };
}
