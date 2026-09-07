import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import { getTableColumns } from 'drizzle-orm';
import { workerPromptCompositionEvents } from '../db/schema';

/**
 * Every field of `PromptCompositionRecord` must have a column to land in.
 *
 * This closes a class of bug rather than one instance of it. `backend` was
 * added to the typed record and to the runner's emit path, but the table
 * created in the same effort was built from the pre-review shape — so the field
 * was silently dropped on insert, with no type error and no runtime warning,
 * and analysis that segmented by backend would have been quietly impossible to
 * repair from stored data. A typed record feeding an untyped `.values()` map
 * gives no protection at all, so the correspondence is asserted here.
 *
 * Deliberately parsed from source rather than imported: the record type lives
 * in `apps/runner`, which this package must not depend on, and a type-level
 * check would not catch the real failure anyway — the insert mapping is a plain
 * object literal, so a missing key is valid TypeScript.
 */
const RUNNER_POLICY = join(import.meta.dir, '../../../apps/runner/src/memory-digest-policy.ts');
const ROUTE = join(import.meta.dir, '../../../apps/web/src/app/api/workers/[id]/route.ts');

/** Fields that are per-event bookkeeping, not part of the record itself. */
const EVENT_ONLY = new Set(['buildIndex', 'ts']);
/** Columns the server sets, never carried on the record. */
const SERVER_SET = new Set(['id', 'workerId', 'taskId', 'buildIndex', 'ts']);

function recordFields(): string[] {
  const src = readFileSync(RUNNER_POLICY, 'utf8');
  const start = src.indexOf('export interface PromptCompositionRecord {');
  expect(start).toBeGreaterThan(-1);
  const body = src.slice(start, src.indexOf('\n}', start));
  const fields = [...body.matchAll(/^\s{2}([a-zA-Z][a-zA-Z0-9]*)\??:/gm)].map(m => m[1]);
  return fields.filter(f => !EVENT_ONLY.has(f));
}

describe('PromptCompositionRecord ↔ worker_prompt_composition_events', () => {
  const fields = recordFields();

  it('found the record fields (guards against an empty-set pass)', () => {
    expect(fields.length).toBeGreaterThan(8);
    expect(fields).toContain('arm');
    expect(fields).toContain('propensity');
  });

  it('every record field has a column on the table', () => {
    const columns = new Set(Object.keys(getTableColumns(workerPromptCompositionEvents)));
    const missing = fields.filter(f => !columns.has(f));
    expect(missing).toEqual([]);
  });

  // A column with no writer is as broken as a field with no column — it reads
  // as NULL forever and nobody notices.
  //
  // The mapping must be located precisely, not grepped for across the whole
  // route: `route.ts` writes many tables, so a file-wide search for `backend:`
  // matches an unrelated occurrence and the assertion passes even when the
  // composition mapping stopped writing it. (Verified: that exact mutant
  // survived the file-wide version of this test.)
  it('every non-server column is written by the composition insert mapping', () => {
    const route = readFileSync(ROUTE, 'utf8');
    const insertAt = route.indexOf('db.insert(workerPromptCompositionEvents)');
    expect(insertAt).toBeGreaterThan(-1);
    const mapAt = route.lastIndexOf('.map((e: any) => ({', insertAt);
    expect(mapAt).toBeGreaterThan(-1);
    const mapping = route.slice(mapAt, insertAt);
    // Sanity-check the slice really is the mapping, so a refactor that moves
    // things cannot silently reduce this to an empty-string search.
    expect(mapping).toContain('workerId:');
    expect(mapping.length).toBeLessThan(3000);

    const columns = Object.keys(getTableColumns(workerPromptCompositionEvents));
    const unwritten = columns
      .filter(c => !SERVER_SET.has(c))
      .filter(c => !new RegExp(`(^|\\s)${c}:`).test(mapping));
    expect(unwritten).toEqual([]);
  });

  it('the two fields that were silently dropped are now covered', () => {
    const columns = new Set(Object.keys(getTableColumns(workerPromptCompositionEvents)));
    expect(columns.has('backend')).toBe(true);
    expect(columns.has('taskMatchDerivedBy')).toBe(true);
    expect(fields).toContain('backend');
    expect(fields).toContain('taskMatchDerivedBy');
  });
});
