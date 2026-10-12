/**
 * The migrations directory's layout, and the two repairs for a branch that
 * generated a migration off a base that has since moved.
 *
 * drizzle v1 keeps each migration in its own folder, `<YYYYMMDDHHMMSS>_<slug>/`
 * with a `migration.sql` and a `snapshot.json`, and has no journal and no index.
 * Two branches therefore cannot take the same name, and git merges their folders
 * cleanly. What it cannot see is that both snapshots name the same parent: the
 * second one's DDL was diffed against a schema the first already changed.
 *
 *  - `check`      (CI on every PR, `bun run migrations:layout-check`): the tree
 *                 must be readable as v1 and consistent with the base. A numbered
 *                 `NNNN_name.sql` or a `meta/` directory (a pre-cutover branch, or
 *                 a 0.31 kit run on a v1 checkout) is a migration drizzle v1
 *                 would never read, so its DDL would be skipped with the deploy
 *                 green. Fails closed.
 *  - `commute`    (`bun run migrations:commute`): `drizzle-kit check`, which exits
 *                 non-zero when two snapshots share a parent.
 *  - `regenerate` (`bun run migrations:regenerate`, run by the migration-collision
 *                 retry task and `conflicts:generated`): reset `drizzle/` to the
 *                 base's exact state and re-run `drizzle-kit generate`, so the
 *                 branch's schema change is re-diffed against the base's newest
 *                 snapshot. It is also how a branch cut before the cutover moves
 *                 onto the folder layout: its legacy `NNNN_name.sql` is replaced
 *                 by a folder generated from the same schema change.
 *
 * Open-PR-vs-open-PR collisions (neither merged yet) cannot be seen from either
 * branch; they are caught at landing, by `classifyPullRequestMigrations` and the
 * commute check on the merge ref.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { detectLayout, MigrationLayoutError, V1_FOLDER, v1LayoutProblems, type MigrationLayout } from './migrate-tree';

// ── git plumbing ─────────────────────────────────────────────────────────────

function git(cwd: string, args: string[], allowFail = false): string {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0 && !allowFail) {
    throw new Error(`git ${args.join(' ')} failed: ${(r.stderr || r.stdout).trim()}`);
  }
  return r.status === 0 ? r.stdout : '';
}

function lines(s: string): string[] {
  return s.split('\n').map((l) => l.trim()).filter(Boolean);
}

export interface RepoPaths {
  /** Repo root. */
  root: string;
  /** Drizzle `out` dir, relative to the root (e.g. `packages/core/drizzle`). */
  drizzleDir: string;
}

// ── layout ───────────────────────────────────────────────────────────────────

/** v1 migration folder names (not files) in `base`'s drizzle dir. */
function baseFolders(paths: RepoPaths, base: string): string[] {
  const files = lines(git(paths.root, ['ls-tree', '-r', '--name-only', base, `${paths.drizzleDir}/`]));
  const names = new Set<string>();
  for (const f of files) {
    const parts = relative(paths.drizzleDir, f).split('/');
    if (parts.length === 2 && V1_FOLDER.test(parts[0]!) && parts[1] === 'migration.sql') names.add(parts[0]!);
  }
  return [...names].sort();
}

/** True when `base`'s drizzle dir holds v1 migration folders. */
export function baseIsV1(paths: RepoPaths, base: string): boolean {
  return baseFolders(paths, base).length > 0;
}

/**
 * Everything that makes the working tree's migrations unreadable as v1, or
 * inconsistent with the base's. Empty means clean.
 */
export function layoutProblems(paths: RepoPaths, base: string): string[] {
  const dir = join(paths.root, paths.drizzleDir);
  let layout: MigrationLayout;
  try {
    layout = detectLayout(dir);
  } catch (err) {
    if (err instanceof MigrationLayoutError) return [err.message];
    throw err;
  }
  if (layout === 'v1') return v1LayoutProblems(dir, { requireSnapshot: true });
  return [
    `${paths.drizzleDir} is in the legacy journal layout, but this repo uses drizzle v1 migration folders` +
      (baseIsV1(paths, base) ? ` (${base} does)` : '') +
      `. A legacy migration is never read there. Merge the base, then run bun run migrations:regenerate --base=${base}.`,
  ];
}

// ── drizzle-kit ──────────────────────────────────────────────────────────────

/**
 * The installed drizzle-kit, the same binary `bun db:generate` runs. Never
 * `bun x`: outside the repo's node_modules that silently downloads whatever
 * `latest` is, which is not the pinned rc.
 */
export function findDrizzleKit(pkgDir: string): string {
  for (let dir = resolve(pkgDir); ; dir = dirname(dir)) {
    const bin = join(dir, 'node_modules', '.bin', 'drizzle-kit');
    if (existsSync(bin)) return bin;
    if (dirname(dir) === dir) throw new Error(`drizzle-kit is not installed above ${pkgDir}; run bun install`);
  }
}

function runDrizzleGenerate(pkgDir: string, extra: string[]): void {
  const r = spawnSync(findDrizzleKit(pkgDir), ['generate', ...extra], {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (r.status !== 0 || /^Error:/m.test(out)) {
    throw new Error(`drizzle-kit generate failed (exit ${r.status}):\n${out}`);
  }
}

/**
 * `drizzle-kit check`: exits non-zero when two migrations do not commute (two
 * snapshots sharing a parent, which is what two branches that each ran
 * generate off the same base look like once merged). Output is passed through
 * for the CI log. A killed or unspawnable kit has no status: a failure.
 */
export function runDrizzleCheck(pkgDir: string): { ok: boolean; output: string } {
  const r = spawnSync(findDrizzleKit(pkgDir), ['check'], { cwd: pkgDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  const output = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  return { ok: r.status === 0 && !/^Error:/m.test(output), output };
}

// ── regenerate ───────────────────────────────────────────────────────────────

export interface RegenerateResult {
  /** The branch's own migrations that were replaced (folders, or legacy files). */
  removed: string[];
  /** The folders generated in their place. */
  generated: string[];
  /** True when the regenerated SQL is not statement-for-statement the SQL it replaced. */
  sqlChanged: boolean;
}

function statements(sql: string): string[] {
  return sql
    .split('--> statement-breakpoint')
    .map((s) => s.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .sort();
}

/** `<slug>` of a v1 folder name or a legacy `NNNN_<slug>.sql`. */
function slugOf(ownName: string): string {
  return ownName.replace(/\.sql$/, '').replace(/^\d{14}_/, '').replace(/^\d{4,}_/, '');
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
}

/**
 * Reset the drizzle dir to `base`'s exact state, then regenerate the branch's
 * schema change on top of it. The branch must already contain `base` (merged
 * in, or a merge in progress), so `schema.ts` holds both sides' tables.
 *
 * The branch's own migrations are whatever the working dir holds that the base
 * does not: v1 folders it generated, or legacy numbered files it still carries
 * from before the cutover. Their SQL is read first so a hand-written
 * (`--custom`) migration can be carried over verbatim.
 */
export function regenerateAgainstBase(paths: RepoPaths, base: string): RegenerateResult {
  const { root, drizzleDir } = paths;
  const pkgDir = resolve(root, drizzleDir, '..');
  if (!baseIsV1(paths, base)) {
    throw new MigrationLayoutError(
      `${base} holds no drizzle v1 migration folders in ${drizzleDir}, so there is no tree to regenerate against. ` +
        `Merge a base that has the folder layout first.`
    );
  }
  const baseSha = git(root, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const mergeHead = git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).trim();
  const contains = (rev: string) => spawnSync('git', ['merge-base', '--is-ancestor', baseSha, rev], { cwd: root }).status === 0;
  if (!contains('HEAD') && !(mergeHead && contains(mergeHead))) {
    throw new Error(`${base} is not merged into this branch. Run \`git merge ${base}\` first (resolve any non-drizzle conflicts), then re-run.`);
  }
  const unmerged = lines(git(root, ['diff', '--name-only', '--diff-filter=U']));
  const foreign = unmerged.filter((f) => !f.startsWith(`${drizzleDir}/`));
  if (foreign.length) {
    throw new Error(`Resolve these conflicts first; regenerate only resolves ${drizzleDir}/:\n  ${foreign.join('\n  ')}`);
  }

  const absDrizzle = join(root, drizzleDir);
  const onBase = new Set(baseFolders(paths, base));
  const own: Array<{ name: string; sql: string }> = [];
  for (const e of readdirSync(absDrizzle, { withFileTypes: true })) {
    if (e.isDirectory() && V1_FOLDER.test(e.name) && !onBase.has(e.name) && existsSync(join(absDrizzle, e.name, 'migration.sql'))) {
      own.push({ name: e.name, sql: readFileSync(join(absDrizzle, e.name, 'migration.sql'), 'utf8') });
    } else if (e.isFile() && /^\d{4,}_[A-Za-z0-9_]+\.sql$/.test(e.name)) {
      own.push({ name: e.name, sql: readFileSync(join(absDrizzle, e.name), 'utf8') });
    }
  }
  own.sort((a, b) => a.name.localeCompare(b.name));

  // drizzle/ := base's drizzle/, byte for byte (folders, snapshots, SQL).
  git(root, ['checkout', baseSha, '--', drizzleDir]);
  const baseTracked = new Set(lines(git(root, ['ls-tree', '-r', '--name-only', baseSha, `${drizzleDir}/`])));
  for (const abs of walk(absDrizzle)) {
    if (!baseTracked.has(relative(root, abs))) rmSync(abs);
  }
  // Empty folders left behind by the removals would still make a mixed tree.
  for (const e of readdirSync(absDrizzle, { withFileTypes: true })) {
    if (e.isDirectory() && readdirSync(join(absDrizzle, e.name)).length === 0) rmSync(join(absDrizzle, e.name), { recursive: true });
  }

  const before = new Set(readdirSync(absDrizzle));
  const newFolders = () => readdirSync(absDrizzle).filter((f) => V1_FOLDER.test(f) && !before.has(f)).sort();
  const name = own.length === 1 ? [`--name=${slugOf(own[0]!.name)}`] : [];
  runDrizzleGenerate(pkgDir, name);
  let generated = newFolders();

  let sqlChanged = false;
  if (generated.length === 0 && own.length > 0) {
    // Nothing to diff: the branch's migrations were hand-written (`--custom`)
    // data migrations. Re-mint each and carry its SQL.
    for (const o of own) {
      const mark = new Set(readdirSync(absDrizzle));
      runDrizzleGenerate(pkgDir, ['--custom', `--name=${slugOf(o.name)}`]);
      const fresh = readdirSync(absDrizzle).filter((f) => V1_FOLDER.test(f) && !mark.has(f));
      if (fresh.length !== 1) throw new Error(`expected one custom migration for ${o.name}, got ${fresh.join(', ') || 'none'}`);
      writeFileSync(join(absDrizzle, fresh[0]!, 'migration.sql'), o.sql);
    }
    generated = newFolders();
  } else {
    const was = statements(own.map((o) => o.sql).join('\n--> statement-breakpoint\n'));
    const now = statements(generated.map((f) => readFileSync(join(absDrizzle, f, 'migration.sql'), 'utf8')).join('\n--> statement-breakpoint\n'));
    sqlChanged = was.length !== now.length || was.some((s, i) => s !== now[i]);
  }

  git(root, ['add', '-A', '--', drizzleDir]);
  return { removed: own.map((o) => o.name), generated, sqlChanged };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { cmd: string; base: string; paths: RepoPaths } {
  const cmd = argv[0] ?? '';
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  return {
    cmd,
    base: flag('base') ?? 'origin/dev',
    paths: { root, drizzleDir: flag('drizzle-dir') ?? 'packages/core/drizzle' },
  };
}

if (import.meta.main) {
  const { cmd, base, paths } = parseArgs(process.argv.slice(2));
  try {
    if (cmd === 'check') {
      const problems = layoutProblems(paths, base);
      if (problems.length > 0) {
        for (const p of problems) console.error(`::error file=${paths.drizzleDir}::Migration layout: ${p}`);
        process.exit(1);
      }
      console.log(`Migration layout is clean (drizzle v1 folders; names cannot collide against ${base}).`);
      process.exit(0);
    } else if (cmd === 'commute') {
      const { ok, output } = runDrizzleCheck(resolve(paths.root, paths.drizzleDir, '..'));
      if (!ok) {
        console.error(`::error file=${paths.drizzleDir}::Migrations do not commute: drizzle-kit check failed\n${output.trim()}`);
        console.error(`\nTwo branches each generated a migration from the same base. Merge the base, then run bun run migrations:regenerate --base=${base}.`);
        process.exit(1);
      }
      console.log('Migrations commute (drizzle-kit check passed).');
      process.exit(0);
    } else if (cmd === 'regenerate') {
      const r = regenerateAgainstBase(paths, base);
      if (r.removed.length === 0 && r.generated.length === 0) {
        console.log(`No branch migrations; ${paths.drizzleDir}/ now matches ${base}.`);
        process.exit(0);
      }
      console.log(`Regenerated against ${base}:\n  removed:   ${r.removed.join(', ') || '(none)'}\n  generated: ${r.generated.join(', ') || '(none)'}`);
      if (r.sqlChanged) {
        console.error(
          '\nThe regenerated SQL differs from the SQL it replaced. Read it: hand-written statements in the old file are NOT carried over, and the base may have touched the same tables. Re-add anything missing before committing.',
        );
        process.exit(3);
      }
      console.log('Staged. Commit and push.');
      process.exit(0);
    } else {
      console.error('usage: bun packages/core/db/migration-layout.ts <check|commute|regenerate> [--base=origin/dev] [--drizzle-dir=packages/core/drizzle]');
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
