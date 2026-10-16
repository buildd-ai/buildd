#!/usr/bin/env bun
// Converts packages/core/drizzle from the legacy journal layout to drizzle v1's
// folder-per-migration layout. Reproducible: re-run it on a mission-branch
// refresh to redo the conversion from whatever legacy tree dev now holds.
// Design: knowledge-base buildd/design/drizzle-v1-migration-layout.md §2.
//
//   bun scripts/migrations-cutover.ts [--from=HEAD] [--rebase-name=snapshot_rebase]
//
// 1. Replaces packages/core/drizzle with the legacy tree at `--from` (default
//    HEAD; the schema.ts it must match) and emits the legacy map (tag, exact-ms `when`, sha256, folder
//    name `up` will give it) to packages/core/db/legacy-migrations.json.
// 2. Runs `drizzle-kit up` and asserts every legacy folder exists under its
//    predicted name with the same bytes, then roots the baseline snapshot (the
//    squash removed its parent).
// 3. Runs generate once. The kit renders partial-index predicates and CHECK
//    constraints differently from 0.31, so that migration is churn, not a
//    schema change: its snapshot.json is kept, its SQL becomes a comment.
// 4. Runs generate again, which must say there is nothing to migrate, and
//    `drizzle-kit check`.
//
// Nothing here touches a database: generate, up and check read no credentials.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { legacyMapFromJournal, assertLegacyMapMatchesTree, LEGACY_MIGRATIONS_PATH } from '../packages/core/db/legacy-migrations';
import { readMigrationTree } from '../packages/core/db/migrate-tree';
import { findDrizzleKit } from '../packages/core/db/migration-layout';
import { ROOT_SNAPSHOT_ID } from '../packages/core/db/migrate-drift';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'packages/core');
const DRIZZLE = join(PKG, 'drizzle');
const DRIZZLE_REL = 'packages/core/drizzle';

const flag = (n: string) => process.argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const from = flag('from') ?? 'HEAD';
const rebaseName = flag('rebase-name') ?? 'snapshot_rebase';

function git(args: string[]): string {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

function kit(args: string[]): string {
  const r = spawnSync(findDrizzleKit(PKG), args, { cwd: PKG, encoding: 'utf8', timeout: 300_000 });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 || /^Error:/m.test(out)) throw new Error(`drizzle-kit ${args.join(' ')} failed (exit ${r.status}):\n${out}`);
  return out;
}

function main() {
  // 1. The legacy tree at `from`, exactly.
  rmSync(DRIZZLE, { recursive: true, force: true });
  git(['checkout', from, '--', DRIZZLE_REL]);
  const journal = JSON.parse(readFileSync(join(DRIZZLE, 'meta/_journal.json'), 'utf8')) as {
    entries: Array<{ idx: number; when: number; tag: string; baseline?: boolean }>;
  };
  const legacy = legacyMapFromJournal(journal, (tag) => readFileSync(join(DRIZZLE, `${tag}.sql`), 'utf8'));
  writeFileSync(LEGACY_MIGRATIONS_PATH, `${JSON.stringify(legacy, null, 2)}\n`);

  // 2. up, then prove it was lossless.
  kit(['up']);
  assertLegacyMapMatchesTree(legacy, readMigrationTree(DRIZZLE));
  for (const leftover of ['meta', ...readdirSync(DRIZZLE).filter((f) => f.endsWith('.sql'))]) {
    if (existsSync(join(DRIZZLE, leftover))) throw new Error(`drizzle-kit up left ${leftover} behind`);
  }

  // The squashed baseline's snapshot still names a parent that was squashed away
  // with the history before it. Root it, or the chain has a gap at its start.
  const baselineSnapshot = join(DRIZZLE, legacy[0]!.name, 'snapshot.json');
  const snap = JSON.parse(readFileSync(baselineSnapshot, 'utf8')) as { prevIds?: string[] };
  snap.prevIds = [ROOT_SNAPSHOT_ID];
  writeFileSync(baselineSnapshot, JSON.stringify(snap, null, 2));

  // 3. The rebase migration: keep its snapshot, drop its churn.
  const before = new Set(readdirSync(DRIZZLE));
  kit(['generate', `--name=${rebaseName}`]);
  const added = readdirSync(DRIZZLE).filter((f) => !before.has(f));
  if (added.length !== 1) {
    // Nothing to rebase is a fine outcome only if a later cutover has no churn.
    if (added.length === 0) console.log('generate found no representation churn; no rebase migration written');
    else throw new Error(`expected one rebase migration, got ${added.join(', ')}`);
  } else {
    mkdirSync(join(DRIZZLE, added[0]), { recursive: true });
    writeFileSync(
      join(DRIZZLE, added[0], 'migration.sql'),
      '-- Snapshot rebase: no DDL. drizzle v1 renders some expressions differently (partial index\n' +
        '-- predicates, CHECK constraints); the snapshot is kept so generate converges, the churn is not.\n',
    );
  }

  // 4. It must converge.
  const again = kit(['generate']);
  if (!/No schema changes/.test(again)) throw new Error(`a second generate still has changes:\n${again}`);
  kit(['check']);
  console.log(`Cutover done from ${from}: ${legacy.length} legacy folders, ${added.length} rebase migration(s), map at ${LEGACY_MIGRATIONS_PATH}.`);
}

main();
