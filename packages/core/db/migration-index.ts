/**
 * Migration-index collisions: detect them against the base branch, and repair
 * them by regenerating, not by hand.
 *
 * drizzle-kit takes the next index from the local journal, so two branches
 * that each run `db:generate` off the same base mint the same `NNNN_`. Git does
 * not see it (the `.sql` names differ); only the journal and the
 * `meta/NNNN_snapshot.json` clash, and only once both have merged. Parallel
 * generation cannot be made to pick distinct numbers without a central
 * allocator drizzle-kit does not have, so the rule is enforced at the two
 * places that can see both sides:
 *
 *  - `check`    (CI on every PR, `bun run migrations:index-check`): every
 *               migration the branch adds must sit above the base's newest
 *               index. Fails naming the colliding file and the next free index.
 *  - `renumber` (`bun run migrations:renumber`, run by the migration-collision
 *               retry task): reset `drizzle/` to the base's exact state and
 *               re-run `drizzle-kit generate`, so the branch's schema change is
 *               re-diffed against the base's newest snapshot and lands at the
 *               next free index with a fresh journal entry and snapshot.
 *
 * Open-PR-vs-open-PR collisions (neither merged yet) are caught at landing by
 * `classifyPullRequestMigrations`, which dispatches the same renumber retry.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';

const MIGRATION_FILE = /^(\d{4,})_([A-Za-z0-9_]+)\.sql$/;

export function parseMigrationFile(file: string): { index: number; name: string } | null {
  const m = MIGRATION_FILE.exec(basename(file));
  return m ? { index: Number(m[1]), name: m[2] } : null;
}

export function formatMigrationIndex(index: number): string {
  return String(index).padStart(4, '0');
}

export interface IndexCollision {
  /** The migration this branch adds. */
  file: string;
  /** A base migration at the same index, or null when the file merely sits below the base's newest. */
  baseFile: string | null;
  /** Newest migration on the base. */
  baseNewest: string;
  /** Index this migration must move to. */
  nextFreeIndex: number;
}

/**
 * Every added migration must be numbered above the base's newest. Equal is a
 * collision outright; below is one too, because drizzle applies by the
 * journal's `when` high-water-mark and a below-mark entry is refused at deploy.
 */
export function findIndexCollisions(addedFiles: readonly string[], baseFiles: readonly string[]): IndexCollision[] {
  const base = baseFiles
    .map((f) => ({ file: basename(f), parsed: parseMigrationFile(f) }))
    .filter((b): b is { file: string; parsed: { index: number; name: string } } => b.parsed != null)
    .sort((a, b) => a.parsed.index - b.parsed.index);
  if (base.length === 0) return [];
  const newest = base[base.length - 1];
  const byIndex = new Map(base.map((b) => [b.parsed.index, b.file]));

  const added = addedFiles
    .map((f) => ({ file: basename(f), parsed: parseMigrationFile(f) }))
    .filter((a): a is { file: string; parsed: { index: number; name: string } } => a.parsed != null)
    .sort((a, b) => a.parsed.index - b.parsed.index);

  return added
    .map((a, i) => ({ a, nextFreeIndex: newest.parsed.index + 1 + i }))
    .filter(({ a }) => a.parsed.index <= newest.parsed.index)
    .map(({ a, nextFreeIndex }) => ({
      file: a.file,
      baseFile: byIndex.get(a.parsed.index) ?? null,
      baseNewest: newest.file,
      nextFreeIndex,
    }));
}

export function describeCollision(c: IndexCollision): string {
  const why = c.baseFile
    ? `index ${c.file.slice(0, 4)} is already taken on the base by ${c.baseFile}`
    : `it sits below the base's newest migration ${c.baseNewest}`;
  return `${c.file}: ${why}. Next free index: ${formatMigrationIndex(c.nextFreeIndex)}.`;
}

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

function baseMigrationFiles(paths: RepoPaths, base: string): string[] {
  return lines(git(paths.root, ['ls-tree', '--name-only', base, `${paths.drizzleDir}/`])).filter((f) => parseMigrationFile(f));
}

/** Migrations the branch adds: present at HEAD, absent at the merge-base with `base`. */
function addedMigrationFiles(paths: RepoPaths, base: string): string[] {
  const mergeBase = git(paths.root, ['merge-base', base, 'HEAD']).trim();
  return lines(
    git(paths.root, ['diff', '--name-only', '--diff-filter=A', mergeBase, 'HEAD', '--', `${paths.drizzleDir}/`]),
  ).filter((f) => parseMigrationFile(f));
}

export function checkAgainstBase(paths: RepoPaths, base: string): IndexCollision[] {
  return findIndexCollisions(addedMigrationFiles(paths, base), baseMigrationFiles(paths, base));
}

// ── renumber ─────────────────────────────────────────────────────────────────

export interface RenumberResult {
  removed: string[];
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

/**
 * The installed (and patched — see drizzle-kit-patch.test.ts) drizzle-kit, the
 * same binary `bun db:generate` runs. Never `bun x`: outside the repo's
 * node_modules that silently downloads an unpatched `drizzle-kit@latest`.
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
  // drizzle-kit can abort and still exit 0 (see build.yml "Check migrations are up to date").
  if (r.status !== 0 || /^Error:|is not of the latest version/m.test(out)) {
    throw new Error(`drizzle-kit generate failed (exit ${r.status}):\n${out}`);
  }
}

/**
 * Move freshly generated migrations up so the first sits at `minIndex`. Only
 * the number changes (file names, journal `idx`/`tag`): the SQL and snapshot
 * content were just generated against the base, so nothing goes stale. drizzle
 * reads migrations by journal tag, so the gap this leaves is harmless.
 */
function shiftGenerated(absDrizzle: string, generated: string[], minIndex: number): string[] {
  const first = parseMigrationFile(generated[0])!.index;
  if (first >= minIndex) return generated;
  const shift = minIndex - first;
  const journalPath = join(absDrizzle, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number; tag: string }[] };
  const moved = [...generated].reverse().map((f) => {
    const { index, name } = parseMigrationFile(f)!;
    const to = `${formatMigrationIndex(index + shift)}_${name}`;
    renameSync(join(absDrizzle, f), join(absDrizzle, `${to}.sql`));
    renameSync(
      join(absDrizzle, 'meta', `${formatMigrationIndex(index)}_snapshot.json`),
      join(absDrizzle, 'meta', `${formatMigrationIndex(index + shift)}_snapshot.json`),
    );
    const entry = journal.entries.find((e) => e.tag === f.replace(/\.sql$/, ''))!;
    entry.idx = index + shift;
    entry.tag = to;
    return `${to}.sql`;
  });
  // Same serialisation drizzle-kit writes, so the next generate diffs cleanly.
  writeFileSync(journalPath, JSON.stringify(journal, null, 2));
  return moved.reverse();
}

/**
 * Reset the drizzle dir to `base`'s exact state, then regenerate the branch's
 * schema change on top of it. The branch must already contain `base` (merged
 * in, or a merge in progress), so `schema.ts` holds both sides' tables.
 *
 * `minIndex` is for a collision with another OPEN PR whose migration is not on
 * the base yet: regenerating against the base alone would mint its number
 * again, so start past it.
 */
export function renumberAgainstBase(paths: RepoPaths, base: string, opts: { minIndex?: number } = {}): RenumberResult {
  const { root, drizzleDir } = paths;
  const pkgDir = resolve(root, drizzleDir, '..');
  const baseSha = git(root, ['rev-parse', '--verify', `${base}^{commit}`]).trim();
  const mergeHead = git(root, ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], true).trim();
  const contains = (rev: string) => spawnSync('git', ['merge-base', '--is-ancestor', baseSha, rev], { cwd: root }).status === 0;
  if (!contains('HEAD') && !(mergeHead && contains(mergeHead))) {
    throw new Error(`${base} is not merged into this branch. Run \`git merge ${base}\` first (resolve any non-drizzle conflicts), then re-run.`);
  }
  const unmerged = lines(git(root, ['diff', '--name-only', '--diff-filter=U']));
  const foreign = unmerged.filter((f) => !f.startsWith(`${drizzleDir}/`));
  if (foreign.length) {
    throw new Error(`Resolve these conflicts first; renumber only resolves ${drizzleDir}/:\n  ${foreign.join('\n  ')}`);
  }

  const absDrizzle = join(root, drizzleDir);
  const baseFiles = new Set(baseMigrationFiles(paths, base).map((f) => basename(f)));
  const own = readdirSync(absDrizzle)
    .filter((f) => parseMigrationFile(f) && !baseFiles.has(f))
    .sort((a, b) => parseMigrationFile(a)!.index - parseMigrationFile(b)!.index);
  const ownSql = own.map((f) => ({ file: f, sql: readFileSync(join(absDrizzle, f), 'utf8') }));

  // drizzle/ := base's drizzle/, byte for byte (journal, snapshots, SQL).
  git(root, ['checkout', baseSha, '--', drizzleDir]);
  const baseTracked = new Set(lines(git(root, ['ls-tree', '-r', '--name-only', baseSha, `${drizzleDir}/`])));
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? walk(join(dir, d.name)) : [join(dir, d.name)]));
  for (const abs of walk(absDrizzle)) {
    if (!baseTracked.has(relative(root, abs))) rmSync(abs);
  }

  const before = new Set(readdirSync(absDrizzle));
  const newFiles = () => readdirSync(absDrizzle).filter((f) => parseMigrationFile(f) && !before.has(f)).sort();
  const name = ownSql.length === 1 ? [`--name=${parseMigrationFile(ownSql[0].file)!.name}`] : [];
  runDrizzleGenerate(pkgDir, name);
  let generated = newFiles();

  let sqlChanged = false;
  if (generated.length === 0 && ownSql.length > 0) {
    // Nothing to diff: the branch's migrations were hand-written (`--custom`)
    // data migrations. Re-mint each at the next free index and carry its SQL.
    for (const o of ownSql) {
      const mark = new Set(readdirSync(absDrizzle));
      runDrizzleGenerate(pkgDir, ['--custom', `--name=${parseMigrationFile(o.file)!.name}`]);
      const fresh = readdirSync(absDrizzle).filter((f) => parseMigrationFile(f) && !mark.has(f));
      if (fresh.length !== 1) throw new Error(`expected one custom migration for ${o.file}, got ${fresh.join(', ') || 'none'}`);
      writeFileSync(join(absDrizzle, fresh[0]), o.sql);
    }
    generated = newFiles();
  } else {
    const was = statements(ownSql.map((o) => o.sql).join('\n--> statement-breakpoint\n'));
    const now = statements(generated.map((f) => readFileSync(join(absDrizzle, f), 'utf8')).join('\n--> statement-breakpoint\n'));
    sqlChanged = was.length !== now.length || was.some((s, i) => s !== now[i]);
  }

  if (opts.minIndex != null && generated.length > 0) generated = shiftGenerated(absDrizzle, generated, opts.minIndex);

  git(root, ['add', '-A', '--', drizzleDir]);
  return { removed: own, generated, sqlChanged };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { cmd: string; base: string; minIndex?: number; paths: RepoPaths } {
  const cmd = argv[0] ?? '';
  const flag = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
  const root = git(process.cwd(), ['rev-parse', '--show-toplevel']).trim();
  return {
    cmd,
    base: flag('base') ?? 'origin/dev',
    minIndex: flag('min-index') != null ? Number(flag('min-index')) : undefined,
    paths: { root, drizzleDir: flag('drizzle-dir') ?? 'packages/core/drizzle' },
  };
}

if (import.meta.main) {
  const { cmd, base, minIndex, paths } = parseArgs(process.argv.slice(2));
  try {
    if (cmd === 'check') {
      const collisions = checkAgainstBase(paths, base);
      if (collisions.length === 0) {
        console.log(`Migration indices are free against ${base}.`);
        process.exit(0);
      }
      for (const c of collisions) console.error(`::error file=${paths.drizzleDir}/${c.file}::Migration index collision: ${describeCollision(c)}`);
      console.error(`\nFix: git merge ${base} && bun run migrations:renumber --base=${base}  (regenerates at the next free index; never hand-edit the journal)`);
      process.exit(1);
    } else if (cmd === 'renumber') {
      const r = renumberAgainstBase(paths, base, { minIndex });
      if (r.removed.length === 0 && r.generated.length === 0) {
        console.log(`No branch migrations; ${paths.drizzleDir}/ now matches ${base}.`);
        process.exit(0);
      }
      console.log(`Renumbered against ${base}:\n  removed:   ${r.removed.join(', ') || '(none)'}\n  generated: ${r.generated.join(', ') || '(none)'}`);
      // The result is staged, not committed, so check the generated names directly.
      const left = findIndexCollisions(r.generated, baseMigrationFiles(paths, base));
      if (left.length) {
        for (const c of left) console.error(`still colliding: ${describeCollision(c)}`);
        process.exit(1);
      }
      if (r.sqlChanged) {
        console.error(
          '\nThe regenerated SQL differs from the SQL it replaced. Read it: hand-written statements in the old file are NOT carried over, and the base may have touched the same tables. Re-add anything missing before committing.',
        );
        process.exit(3);
      }
      console.log('Staged. Commit and push.');
      process.exit(0);
    } else {
      console.error('usage: bun packages/core/db/migration-index.ts <check|renumber> [--base=origin/dev] [--min-index=N] [--drizzle-dir=packages/core/drizzle]');
      process.exit(2);
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
