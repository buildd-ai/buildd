/**
 * Reading `gitConfig.derivedFiles` (DerivedFileRule): one rule set for the
 * runner, which registers merge drivers from it, and the workspace API, which
 * refuses a rule the runner would drop instead of storing it silently.
 */

import type { DerivedFileRule } from './types';

export type NormalizedDerivedFileRule = Required<DerivedFileRule>;

const MAX_RULES = 20;

/** Patterns that cover (nearly) the whole tree: a driver there would swallow real conflicts. */
const REPO_WIDE = /^[/*]*$/;

/**
 * Migration chains are never regenerated: renumbering reorders schema changes,
 * and each file carries DDL only its author can reproduce. The drizzle journal
 * included — the migration-collision path owns it.
 */
const MIGRATION_CHAIN = /(^|\/)(drizzle|migrations?|migrate|alembic|versions)(\/|$)|\.sql$/i;

/** Read `gitConfig.derivedFiles` defensively: anything unsafe or malformed is dropped. */
export function normalizeDerivedFiles(input: unknown): NormalizedDerivedFileRule[] {
  if (!Array.isArray(input)) return [];
  const out: NormalizedDerivedFileRule[] = [];
  for (const raw of input) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const glob = typeof r.glob === 'string' ? r.glob.trim() : '';
    const regenerate = typeof r.regenerate === 'string' ? r.regenerate.trim() : '';
    if (!glob || !regenerate) continue;
    // gitattributes patterns are whitespace-delimited; one with a space can't be a single pattern.
    if (/\s/.test(glob) || glob.startsWith('#') || glob.startsWith('!')) continue;
    if (REPO_WIDE.test(glob) || MIGRATION_CHAIN.test(glob)) continue;
    out.push({ glob, regenerate, strategy: r.strategy === 'ours' ? 'ours' : 'theirs' });
    if (out.length >= MAX_RULES) break;
  }
  return out;
}
