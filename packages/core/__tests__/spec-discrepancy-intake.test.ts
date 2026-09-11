import { describe, test, expect, beforeEach, mock } from 'bun:test';

// Minimal fake DB: `select({...}).from(specDiscrepancies).where(filter)` returns
// whatever `rows` currently holds, already pre-filtered by the tests below —
// this module's own filter-application isn't under test here (that's plain
// drizzle `and`/`eq`, exercised for real in spec-discrepancy-ledger.test.ts's
// mock); what matters is that checkIntakeForDiscrepancies issues exactly the
// query it should and wires the result into retrieval correctly.
let rows: Array<{ specPath: string; assertionId: string }> = [];
const selectCalls: unknown[] = [];

mock.module('../db', () => ({
  db: {
    select: (cols: unknown) => {
      selectCalls.push(cols);
      return {
        from: (_table: unknown) => ({
          where: (_filter: unknown) => Promise.resolve(rows),
        }),
      };
    },
  },
}));
mock.module('../db/schema', () => ({
  specDiscrepancies: {
    workspaceId: 'workspaceId',
    specPath: 'specPath',
    assertionId: 'assertionId',
    direction: 'direction',
    status: 'status',
  },
}));
mock.module('drizzle-orm', () => ({
  eq: (col: unknown, val: unknown) => ({ type: 'eq', col, val }),
  and: (...args: unknown[]) => ({ type: 'and', args }),
}));

import {
  buildIntakeQueryText,
  matchDiscrepancyWarnings,
  checkIntakeForDiscrepancies,
} from '../spec-discrepancy-intake';

beforeEach(() => {
  rows = [];
  selectCalls.length = 0;
});

// ─── buildIntakeQueryText ───────────────────────────────────────────────────

describe('buildIntakeQueryText', () => {
  test('joins pathManifest entries and description', () => {
    expect(buildIntakeQueryText(['apps/runner/src/workers.ts'], 'Rename the mount allowlist builder')).toBe(
      'apps/runner/src/workers.ts\nRename the mount allowlist builder',
    );
  });

  test('handles missing pathManifest or description independently', () => {
    expect(buildIntakeQueryText(null, 'just a description')).toBe('just a description');
    expect(buildIntakeQueryText(['a/b.ts'], null)).toBe('a/b.ts');
    expect(buildIntakeQueryText(null, null)).toBe('');
    expect(buildIntakeQueryText([], '')).toBe('');
  });

  test('caps query length so an oversized description cannot inflate retrieval cost', () => {
    const huge = 'x'.repeat(5000);
    expect(buildIntakeQueryText(null, huge).length).toBe(2000);
  });
});

// ─── matchDiscrepancyWarnings ───────────────────────────────────────────────

describe('matchDiscrepancyWarnings', () => {
  const openRows = [
    { specPath: 'docs/design/worker-mount-isolation.md', assertionId: 'mount-symbol' },
    { specPath: 'docs/design/loop-until-verified.md', assertionId: 'loop-field' },
  ];

  test('produces no warnings when there are no open rows', () => {
    expect(matchDiscrepancyWarnings([], [{ sourcePath: 'docs/design/worker-mount-isolation.md' }])).toEqual([]);
  });

  test('produces no warnings when retrieval returns no hits', () => {
    expect(matchDiscrepancyWarnings(openRows, [])).toEqual([]);
  });

  test('a hit landing on an open row specPath produces exactly one warning for it', () => {
    const warnings = matchDiscrepancyWarnings(openRows, [
      { sourcePath: 'docs/design/worker-mount-isolation.md' },
    ]);
    expect(warnings).toEqual([
      {
        specPath: 'docs/design/worker-mount-isolation.md',
        assertionId: 'mount-symbol',
        direction: 'code_ahead',
        message: expect.stringContaining('worker-mount-isolation.md'),
      },
    ]);
  });

  test('a hit whose sourcePath does not match any open row produces nothing', () => {
    expect(matchDiscrepancyWarnings(openRows, [{ sourcePath: 'docs/design/unrelated.md' }])).toEqual([]);
  });

  test('a null sourcePath is skipped rather than throwing', () => {
    expect(matchDiscrepancyWarnings(openRows, [{ sourcePath: null }])).toEqual([]);
  });

  test('duplicate hits on the same open row are deduped to one warning', () => {
    const warnings = matchDiscrepancyWarnings(openRows, [
      { sourcePath: 'docs/design/worker-mount-isolation.md' },
      { sourcePath: 'docs/design/worker-mount-isolation.md' },
    ]);
    expect(warnings).toHaveLength(1);
  });

  test('multiple distinct matches each produce their own warning', () => {
    const warnings = matchDiscrepancyWarnings(openRows, [
      { sourcePath: 'docs/design/worker-mount-isolation.md' },
      { sourcePath: 'docs/design/loop-until-verified.md' },
    ]);
    expect(warnings.map((w) => w.assertionId).sort()).toEqual(['loop-field', 'mount-symbol']);
  });
});

// ─── checkIntakeForDiscrepancies ────────────────────────────────────────────

describe('checkIntakeForDiscrepancies', () => {
  test('skips retrieval entirely when pathManifest and description are both empty', async () => {
    const query = mock(() => Promise.resolve([]));
    const result = await checkIntakeForDiscrepancies('ws-1', {}, { query });
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test('skips retrieval when the workspace has no open code_ahead rows (cheap short-circuit)', async () => {
    rows = [];
    const query = mock(() => Promise.resolve([{ sourcePath: 'docs/design/x.md' }]));
    const result = await checkIntakeForDiscrepancies(
      'ws-1',
      { description: 'touches spec x' },
      { query },
    );
    expect(result).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  test('queries the docs namespace and returns matched warnings when open rows exist', async () => {
    rows = [{ specPath: 'docs/design/worker-mount-isolation.md', assertionId: 'mount-symbol' }];
    const query = mock((namespace: string) => {
      expect(namespace).toBe('ws-1:docs');
      return Promise.resolve([{ sourcePath: 'docs/design/worker-mount-isolation.md' }]);
    });

    const result = await checkIntakeForDiscrepancies(
      'ws-1',
      { pathManifest: ['apps/runner/src/workers.ts'], description: 'rename the mount builder' },
      { query },
    );

    expect(result).toEqual([
      {
        specPath: 'docs/design/worker-mount-isolation.md',
        assertionId: 'mount-symbol',
        direction: 'code_ahead',
        message: expect.any(String),
      },
    ]);
  });
});
