// The frozen ledger of migrations that existed before the drizzle v1 cutover.
//
// The old migrator wrote one tracking row per migration with `created_at` = the
// journal `when` in milliseconds and no name. `drizzle-kit up` turns each of
// those migrations into a `<YYYYMMDDHHMMSS>_<slug>/` folder whose timestamp is
// truncated to the second, so no converted folder's folderMillis equals any
// existing row. This map, generated from the journal at cutover and committed
// OUTSIDE drizzle/ (the tree stays pure drizzle-kit output), is what lets the
// v1 migrator say "this folder already ran" for history it never named:
//
//   a legacy migration is applied iff a row names it, or a row's created_at
//   equals its exact-ms `when`.
//
// Keying on created_at alone after `up` plans the whole history as backfill;
// keying on name alone replays it. See migrate-plan.ts `planMigrationsV1`.
//
// No drizzle-orm import (read by scripts/check-schema-drift.ts from the root).

import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { formatFolderPrefix, V1_FOLDER, type TreeMigration } from './migrate-tree';

export interface LegacyMigration {
  /** The folder `drizzle-kit up` gives it: UTC-second(when) + `_` + tag without `NNNN_`. */
  name: string;
  /** The journal tag, e.g. `0000_baseline`. */
  tag: string;
  /** The journal `when` in ms: what the old migrator stored as created_at. */
  when: number;
  /** sha256 of the .sql, unchanged by `up`. */
  hash: string;
  /** The squashed baseline. Only ever the first entry. */
  baseline?: true;
}

/** Where the committed map lives. Generated at cutover; absent before it. */
export const LEGACY_MIGRATIONS_PATH = join(dirname(fileURLToPath(import.meta.url)), 'legacy-migrations.json');

/**
 * Points the migrator at another map, alongside BUILDD_MIGRATIONS_DIR, for the
 * real-Postgres suite (apps/web/tests/db/migration-layout-v1.test.ts) that
 * converts the current journal into a v1 tree. Nothing in a deploy sets it.
 */
export const LEGACY_MIGRATIONS_ENV = 'BUILDD_LEGACY_MIGRATIONS';

export function predictedFolderName(tag: string, when: number): string {
  return `${formatFolderPrefix(when)}_${tag.replace(/^\d{4,}_/, '')}`;
}

/**
 * Build the map from a legacy journal. `readSql(tag)` returns the .sql text.
 * Refuses two entries in the same UTC second: `up` would give them the same
 * prefix, and the folder order could no longer follow the journal.
 */
export function legacyMapFromJournal(
  journal: { entries: ReadonlyArray<{ idx: number; when: number; tag: string; baseline?: boolean }> },
  readSql: (tag: string) => string
): LegacyMigration[] {
  const ordered = [...journal.entries].sort((a, b) => a.idx - b.idx);
  const seconds = new Map<string, string>();
  for (const e of ordered) {
    const prefix = formatFolderPrefix(e.when);
    const other = seconds.get(prefix);
    if (other) throw new Error(`${other} and ${e.tag} fall in the same second (${prefix}); drizzle-kit up cannot order them`);
    seconds.set(prefix, e.tag);
  }
  return validateLegacyMap(
    ordered.map((e) => ({
      name: predictedFolderName(e.tag, e.when),
      tag: e.tag,
      when: e.when,
      hash: createHash('sha256').update(readSql(e.tag)).digest('hex'),
      ...(e.baseline ? { baseline: true as const } : {}),
    }))
  );
}

/** Check shape and invariants; returns the entries typed. Throws naming the first problem. */
export function validateLegacyMap(raw: unknown): LegacyMigration[] {
  if (!Array.isArray(raw)) throw new Error('legacy migration map must be a JSON array');
  const names = new Set<string>();
  const whens = new Set<number>();
  return raw.map((e: unknown, i: number) => {
    const entry = e as Partial<LegacyMigration> | null;
    const at = `legacy migration map entry ${i}`;
    if (!entry || typeof entry !== 'object') throw new Error(`${at}: not an object`);
    const { name, tag, when, hash, baseline } = entry;
    if (typeof name !== 'string' || !V1_FOLDER.test(name)) throw new Error(`${at}: bad name ${String(name)}`);
    if (typeof tag !== 'string' || tag === '') throw new Error(`${at} (${name}): bad tag`);
    if (typeof when !== 'number' || !Number.isSafeInteger(when) || when <= 0) throw new Error(`${at} (${name}): bad when`);
    if (typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash)) throw new Error(`${at} (${name}): bad hash`);
    if (baseline !== undefined && baseline !== true) throw new Error(`${at} (${name}): baseline must be true or absent`);
    if (baseline && i !== 0) throw new Error(`${at} (${name}): only the first entry may be the baseline`);
    if (name.slice(0, 14) !== formatFolderPrefix(when)) {
      throw new Error(`${at} (${name}): folder prefix does not match when ${when} (${formatFolderPrefix(when)})`);
    }
    if (names.has(name)) throw new Error(`${at}: duplicate name ${name}`);
    if (whens.has(when)) throw new Error(`${at}: duplicate when ${when}`);
    names.add(name);
    whens.add(when);
    return { name, tag, when, hash, ...(baseline ? { baseline } : {}) };
  });
}

/**
 * Read and validate the map. A missing file throws: on a v1 tree, reading it
 * as "no legacy history" would make every converted legacy folder look
 * unapplied. A tree with genuinely no legacy history commits `[]`.
 */
export function loadLegacyMap(path: string): LegacyMigration[] {
  if (!existsSync(path)) {
    throw new Error(
      `No legacy migration map at ${path}. A drizzle v1 tree needs one to recognise migrations applied ` +
        `before the cutover (commit \`[]\` if this tree has none).`
    );
  }
  return validateLegacyMap(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Every legacy entry must be in the tree under its predicted name with the
 * same bytes. A missing folder means the map and tree disagree about history;
 * a changed hash means a legacy migration was edited after the cutover, and a
 * fresh database would no longer get the schema prod has.
 */
export function assertLegacyMapMatchesTree(legacy: readonly LegacyMigration[], tree: readonly TreeMigration[]): void {
  const byName = new Map(tree.map((m) => [m.name, m]));
  const problems: string[] = [];
  for (const e of legacy) {
    const m = byName.get(e.name);
    if (!m) problems.push(`${e.name} (${e.tag}): no folder in the tree`);
    else if (m.hash !== e.hash) problems.push(`${e.name} (${e.tag}): hash differs from the legacy map`);
  }
  if (problems.length > 0) {
    throw new Error(`The migration tree disagrees with the legacy migration map:\n  ${problems.join('\n  ')}`);
  }
}
