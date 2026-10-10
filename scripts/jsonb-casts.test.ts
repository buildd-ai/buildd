import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { BASELINE_PATH, SCHEMA_PATH, findCasts, jsonbColumns, onlyUnknownLeaves, prune, readBaseline, scan } from './jsonb-casts';

/**
 * Ratchet: no new cast of a jsonb column to a hand-written concrete type
 * (see scripts/jsonb-casts.ts for why and how to fix one).
 *
 * Fails when a file has more flagged casts than scripts/jsonb-casts.baseline.json
 * allows, or when the baseline allows more than remain (it must shrink with the
 * code: `bun scripts/jsonb-casts.ts --prune`). Listed in
 * scripts/always-run-tests.txt: the file that adds a cast is never this
 * test's neighbour.
 */
const columns = jsonbColumns(readFileSync(SCHEMA_PATH, 'utf8'));

describe('the scan can fail', () => {
  test('reads the jsonb columns from the schema', () => {
    expect(columns).toContain('waitingFor');
    expect(columns).toContain('gitConfig');
    expect(columns.length).toBeGreaterThan(50);
  });

  test('flags the cast behind the task-sheet crash, single- and multi-line', () => {
    expect(findCasts(`x = (w.waitingFor as { type: string; prompt: string; options?: string[] } | null) ?? null;`, columns)).toHaveLength(1);
    expect(findCasts(`const r = task.result as {\n  summary?: string;\n} | null;`, columns)).toHaveLength(1);
    expect(findCasts(`const c = row?.context as unknown as { attachments: any[] };`, columns)).toHaveLength(1);
  });

  test('passes the honest forms', () => {
    expect(findCasts(`const s = (row.metadata as { shipped?: unknown } | null)?.shipped;`, columns)).toEqual([]);
    expect(findCasts(`const r = (row.result as { repair?: { reconciled?: unknown } } | null);`, columns)).toEqual([]);
    expect(findCasts(`const w = row.waitingFor as WaitingFor | null;`, columns)).toEqual([]);
    expect(findCasts(`const v = row.notAColumn as { a: string };`, columns)).toEqual([]);
  });

  test('onlyUnknownLeaves', () => {
    expect(onlyUnknownLeaves('{ a?: unknown; b: { c?: unknown } }')).toBe(true);
    expect(onlyUnknownLeaves('{ a?: unknown[] }')).toBe(false);
    expect(onlyUnknownLeaves('{ a: string | null }')).toBe(false);
  });

  test('prune only lowers', () => {
    expect(prune({ a: 3, b: 2, c: 1 }, { a: 1, b: 5, d: 4 })).toEqual({ a: 1, b: 2 });
  });
});

describe('jsonb casts (ratchet)', () => {
  const current = scan();
  const baseline = readBaseline();

  test(`no file has more casts than ${BASELINE_PATH} allows`, () => {
    const over = Object.entries(current)
      .filter(([f, n]) => n > (baseline[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} (allowed ${baseline[f] ?? 0})`);
    expect(over, `new jsonb casts to a hand-written type. Read the column as its schema type, or cast to { field?: unknown } and check it (scripts/jsonb-casts.ts):\n  ${over.join('\n  ')}`).toEqual([]);
  });

  test('the baseline shrinks with the code', () => {
    const stale = Object.entries(baseline)
      .filter(([f, n]) => (current[f] ?? 0) < n)
      .map(([f, n]) => `${f}: ${current[f] ?? 0} (baseline ${n})`);
    expect(stale, `fewer casts remain; run \`bun scripts/jsonb-casts.ts --prune\`:\n  ${stale.join('\n  ')}`).toEqual([]);
  });
});
