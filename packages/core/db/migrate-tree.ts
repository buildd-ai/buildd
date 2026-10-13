// Reader for drizzle v1's folder-per-migration layout:
//
//   drizzle/<YYYYMMDDHHMMSS>_<slug>/migration.sql
//   drizzle/<YYYYMMDDHHMMSS>_<slug>/snapshot.json
//
// We own this reader rather than calling drizzle's `readMigrationFiles`, so the
// migrator's only runtime dependency on drizzle v1 is the batch driver. It
// returns exactly what rc.4's `readMigrationFiles` does for the same directory
// (name, sha256 hash, Date.UTC(prefix) folderMillis, the raw breakpoint split),
// pinned in __tests__/migrate-tree.test.ts against real rc.4 output.
//
// Unlike drizzle's reader it fails closed. drizzle silently skips a folder with
// no migration.sql and never looks at a stray root `.sql`; either is a
// migration whose DDL would never run with the deploy still green (the 0067
// class). Every directory entry here must be a recognisable migration folder.
//
// No drizzle-orm import: scripts/check-schema-drift.ts reads this from the repo
// root, where drizzle-orm does not resolve.

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const V1_FOLDER = /^(\d{14})_([A-Za-z0-9_]+)$/;
const LEGACY_SQL = /\.sql$/;
const STATEMENT_BREAKPOINT = '--> statement-breakpoint';

export type MigrationLayout = 'legacy' | 'v1';

export class MigrationLayoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MigrationLayoutError';
  }
}

export interface TreeMigration {
  /** Folder name, `<YYYYMMDDHHMMSS>_<slug>`. What a v1 tracking row's `name` holds. */
  name: string;
  /** sha256 of migration.sql, as drizzle computes it. */
  hash: string;
  /** Date.UTC of the folder prefix: second precision, what stock v1 writes to created_at. */
  folderMillis: number;
  /** migration.sql split on `--> statement-breakpoint`, unmodified. */
  sql: string[];
}

/** Date.UTC of a folder's 14-digit prefix. Refuses a prefix that is not a real date. */
export function folderMillis(name: string): number {
  const m = V1_FOLDER.exec(name);
  if (!m) throw new MigrationLayoutError(`${name}: not a <YYYYMMDDHHMMSS>_<slug> migration folder`);
  const p = m[1]!;
  const ms = Date.UTC(+p.slice(0, 4), +p.slice(4, 6) - 1, +p.slice(6, 8), +p.slice(8, 10), +p.slice(10, 12), +p.slice(12, 14));
  // Date.UTC rolls month 13 into next year; a prefix that does not survive the
  // round trip is not a timestamp drizzle-kit wrote.
  if (formatFolderPrefix(ms) !== p) throw new MigrationLayoutError(`${name}: ${p} is not a valid UTC timestamp`);
  return ms;
}

/** `YYYYMMDDHHMMSS` in UTC, truncated to the second (what `drizzle-kit up` names a folder from a journal `when`). */
export function formatFolderPrefix(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return (
    pad(d.getUTCFullYear(), 4) +
    pad(d.getUTCMonth() + 1) +
    pad(d.getUTCDate()) +
    pad(d.getUTCHours()) +
    pad(d.getUTCMinutes()) +
    pad(d.getUTCSeconds())
  );
}

function entries(dir: string): string[] {
  return readdirSync(dir).filter((e) => !e.startsWith('.'));
}

const isDir = (path: string) => statSync(path).isDirectory();

/** Files that belong to the legacy (journal) layout: root `*.sql` and `meta/`. */
export function legacyLayoutFiles(dir: string): string[] {
  return entries(dir).filter((e) => e === 'meta' || (LEGACY_SQL.test(e) && !isDir(join(dir, e))));
}

/**
 * Everything wrong with `dir` as a v1 tree, as readable lines. Empty means
 * clean. `requireSnapshot` is for the repo layout check: the migrator itself
 * only needs migration.sql, but drizzle-kit cannot diff the next change
 * without the snapshot.
 */
export function v1LayoutProblems(dir: string, opts: { requireSnapshot?: boolean } = {}): string[] {
  const problems: string[] = [];
  for (const e of entries(dir)) {
    const path = join(dir, e);
    if (e === 'meta') {
      problems.push(`meta/: legacy journal directory (drizzle v1 refuses a tree with meta/_journal.json)`);
    } else if (!isDir(path)) {
      problems.push(
        LEGACY_SQL.test(e)
          ? `${e}: legacy-layout migration at the root; drizzle v1 never reads it, so its DDL would never run`
          : `${e}: unexpected file in the migrations directory`
      );
    } else if (!V1_FOLDER.test(e)) {
      problems.push(`${e}/: not a <YYYYMMDDHHMMSS>_<slug> migration folder`);
    } else {
      try {
        folderMillis(e);
      } catch (err) {
        problems.push((err as Error).message);
        continue;
      }
      if (!existsSync(join(path, 'migration.sql'))) {
        problems.push(`${e}: missing migration.sql (drizzle would skip this folder silently)`);
      }
      if (opts.requireSnapshot && !existsSync(join(path, 'snapshot.json'))) {
        problems.push(`${e}: missing snapshot.json`);
      }
    }
  }
  return problems;
}

/**
 * Which layout `dir` holds. Throws on a mix of the two (a pre-cutover branch
 * merged over a v1 tree, or a 0.31 kit run on one) and on an empty directory:
 * neither has a safe reading.
 */
export function detectLayout(dir: string): MigrationLayout {
  const all = entries(dir);
  const folders = all.filter((e) => V1_FOLDER.test(e) && isDir(join(dir, e)));
  const legacy = legacyLayoutFiles(dir);
  if (folders.length > 0 && legacy.length > 0) {
    throw new MigrationLayoutError(
      `${dir} mixes drizzle v1 migration folders with legacy-layout files (${legacy.join(', ')}). ` +
        `A legacy .sql next to v1 folders is never applied. Regenerate the branch's schema change as a v1 ` +
        `folder against the base instead of keeping the legacy file.`
    );
  }
  if (legacy.length > 0) return 'legacy';
  if (folders.length > 0) return 'v1';
  throw new MigrationLayoutError(`${dir} holds no migrations in either layout`);
}

/** Split a migration body on drizzle's breakpoint marker, exactly as drizzle does. */
export function splitStatements(text: string): string[] {
  return text.split(STATEMENT_BREAKPOINT);
}

/** True when no chunk has an executable line: only blank lines and `--` comments. */
export function isCommentOnly(statements: readonly string[]): boolean {
  return statements.every((s) => s.split('\n').every((line) => line.trim() === '' || line.trim().startsWith('--')));
}

/** Read a v1 tree, sorted by name (drizzle's order). Throws on any layout problem. */
export function readMigrationTree(dir: string): TreeMigration[] {
  const problems = v1LayoutProblems(dir);
  if (problems.length > 0) {
    throw new MigrationLayoutError(`Refusing to read ${dir} as a drizzle v1 migration tree:\n  ${problems.join('\n  ')}`);
  }
  return entries(dir)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      const text = readFileSync(join(dir, name, 'migration.sql')).toString();
      return {
        name,
        hash: createHash('sha256').update(text).digest('hex'),
        folderMillis: folderMillis(name),
        sql: splitStatements(text),
      };
    });
}
