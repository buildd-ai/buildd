/**
 * File-scoped memory retrieval: match a task's declared paths against the
 * paths a memory says it is about.
 *
 * Why this exists. Memory injection into a worker prompt used to be keyed on
 * the task *title*, matched as a single `ILIKE '%<whole title>%'`. A title only
 * appears verbatim inside a memory when a previous run of the *same recurring
 * task* wrote one, so targeted memory worked for repeating scheduled work and
 * returned nothing at all for novel work — backwards from where it is useful.
 *
 * Meanwhile both halves of a much better key were already being collected and
 * neither was read: `tasks.path_manifest` (what the task says it will touch)
 * and `memories.files` (what a lesson says it is about). This module is the
 * join between them.
 *
 * The matching rules are deliberately identical to `pathsOverlap` in
 * ./path-overlap.ts — exact match, or one path being a directory prefix of the
 * other. `memoryFilesMatch` below is the executable specification, and the SQL
 * fragment must agree with it; a parity test asserts that on a shared table of
 * cases. Keeping one definition of "these paths overlap" matters because the
 * same question is already asked by path claims and dependency inference.
 *
 * This module is deliberately free of drizzle and schema imports: the runner
 * imports it to decide whether a task declared any concrete scope, and should
 * not pull a query builder in to answer that. The SQL fragment lives in
 * ./memory-file-scope-sql.ts.
 */
import { REPO_WIDE_SENTINEL, stripTrailingSep } from './path-overlap';

/**
 * Upper bound on paths sent to the database in one query.
 *
 * A path manifest is authored, not generated, so it is normally a handful of
 * entries. The cap exists so a pathological manifest cannot turn one retrieval
 * into an unbounded cross join, and it truncates rather than rejecting because
 * a partial path scope still retrieves better than no path scope.
 */
export const MAX_SCOPE_PATHS = 25;

/**
 * Clean a task's path manifest into the paths worth querying.
 *
 * Drops:
 * - the repo-wide sentinel `'**'`, which records that the filer never declared
 *   a scope. It is not a path, and querying it would match every memory —
 *   turning "no scope declared" into "everything is relevant".
 * - blanks, and anything that is not a string (the column is jsonb with only a
 *   compile-time `$type` assertion, so its shape is an assumption about every
 *   writer rather than a guarantee).
 *
 * Then normalises trailing separators and de-duplicates, so
 * `['apps/web/', 'apps/web']` is one path rather than two.
 */
export function normalizeMemoryFileScope(
  manifest: readonly unknown[] | null | undefined,
): string[] {
  if (!Array.isArray(manifest)) return [];
  const seen = new Set<string>();
  for (const raw of manifest) {
    if (typeof raw !== 'string') continue;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === REPO_WIDE_SENTINEL) continue;
    const norm = stripTrailingSep(trimmed);
    if (norm) seen.add(norm);
    if (seen.size >= MAX_SCOPE_PATHS) break;
  }
  return [...seen];
}

/**
 * Does a memory's `files` list overlap a task's declared paths?
 *
 * This is the executable specification the SQL fragment below must match. It is
 * also directly useful to any caller that already has both arrays in memory.
 *
 * Note it does NOT honour the repo-wide sentinel the way `pathsOverlap` does.
 * That is deliberate: `pathsOverlap` answers a *spatial* question ("could these
 * two tasks touch the same file?"), where an undeclared scope must be treated
 * as "possibly yes" to stay safe. Retrieval asks a *relevance* question, where
 * an undeclared scope means "we know nothing", and matching everything would
 * be worse than matching nothing. `normalizeMemoryFileScope` strips the
 * sentinel before it ever reaches here.
 */
export function memoryFilesMatch(
  memoryFiles: readonly string[] | null | undefined,
  scopePaths: readonly string[],
): boolean {
  if (!memoryFiles?.length || scopePaths.length === 0) return false;
  const files = memoryFiles.filter(f => typeof f === 'string' && f.trim()).map(stripTrailingSep);
  for (const p of scopePaths) {
    for (const f of files) {
      if (f === p) return true;
      if (f.startsWith(p + '/')) return true;
      if (p.startsWith(f + '/')) return true;
    }
  }
  return false;
}
