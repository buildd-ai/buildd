import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { installSpecDiscrepancyIntakeDbMock, setStore } from './_spec-discrepancy-intake-db-mock';

installSpecDiscrepancyIntakeDbMock();

import {
  extractPathFromDetail,
  matchRowsByPathManifest,
  matchRowsByDescription,
  dedupeRows,
  toWarning,
  findIntakeWarnings,
  type OpenCodeAheadRow,
  type IntakeQuerier,
} from '../spec-discrepancy-intake';

function row(overrides: Partial<OpenCodeAheadRow> & { specPath: string; assertionId: string }): OpenCodeAheadRow {
  return { evidence: null, ...overrides };
}

beforeEach(() => {
  setStore([]);
});

describe('extractPathFromDetail', () => {
  test('extracts the code path from an evalSymbol pass detail', () => {
    expect(extractPathFromDetail('export of "buildWorkerBwrapArgv" found in apps/runner/src/bwrap-mount-allowlist.ts'))
      .toBe('apps/runner/src/bwrap-mount-allowlist.ts');
  });

  test('extracts the code path from an evalRoute pass detail', () => {
    expect(extractPathFromDetail('POST handler exported from apps/web/src/app/api/foo/route.ts'))
      .toBe('apps/web/src/app/api/foo/route.ts');
  });

  test('extracts a leading path from an evalTestFile detail', () => {
    expect(extractPathFromDetail('apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts exists'))
      .toBe('apps/runner/__tests__/unit/bwrap-runtime-recovery.test.ts');
  });

  test('extracts the code path from an evalConfigKey pass detail', () => {
    expect(extractPathFromDetail('"BUILDD_DISABLE_SANDBOX" found in apps/runner/src/workers.ts'))
      .toBe('apps/runner/src/workers.ts');
  });

  test('returns null when no path-shaped token is present', () => {
    expect(extractPathFromDetail('suppressed until 2026-01-01 — pending phase 1')).toBeNull();
  });

  test('returns null for null/undefined/empty detail', () => {
    expect(extractPathFromDetail(null)).toBeNull();
    expect(extractPathFromDetail(undefined)).toBeNull();
    expect(extractPathFromDetail('')).toBeNull();
  });
});

describe('matchRowsByPathManifest', () => {
  const rows: OpenCodeAheadRow[] = [
    row({
      specPath: 'docs/design/worker-mount-isolation.md',
      assertionId: 'mount-symbol',
      evidence: { detail: 'export of "buildWorkerBwrapArgv" found in apps/runner/src/bwrap-mount-allowlist.ts' },
    }),
    row({ specPath: 'docs/design/loop-until-verified.md', assertionId: 'loop-config-col', evidence: null }),
  ];

  test('undeclared scope (null, empty, or repo-wide sentinel) never matches', () => {
    expect(matchRowsByPathManifest(null, rows)).toEqual([]);
    expect(matchRowsByPathManifest([], rows)).toEqual([]);
    expect(matchRowsByPathManifest(['**'], rows)).toEqual([]);
  });

  test('matches on the spec doc path itself', () => {
    const matched = matchRowsByPathManifest(['docs/design/loop-until-verified.md'], rows);
    expect(matched).toHaveLength(1);
    expect(matched[0].assertionId).toBe('loop-config-col');
  });

  test('matches on the resolved code path extracted from evidence', () => {
    const matched = matchRowsByPathManifest(['apps/runner/src/bwrap-mount-allowlist.ts'], rows);
    expect(matched).toHaveLength(1);
    expect(matched[0].assertionId).toBe('mount-symbol');
  });

  test('matches on a directory prefix of the resolved code path', () => {
    const matched = matchRowsByPathManifest(['apps/runner/src'], rows);
    expect(matched).toHaveLength(1);
    expect(matched[0].assertionId).toBe('mount-symbol');
  });

  test('an unrelated path matches nothing', () => {
    expect(matchRowsByPathManifest(['apps/web/src/lib/unrelated.ts'], rows)).toEqual([]);
  });
});

describe('matchRowsByDescription', () => {
  const rows: OpenCodeAheadRow[] = [
    row({ specPath: 'docs/design/worker-mount-isolation.md', assertionId: 'mount-symbol' }),
    row({ specPath: 'docs/design/loop-until-verified.md', assertionId: 'loop-config-col' }),
  ];

  function fakeQuerier(hits: Array<{ sourcePath: string | null; score: number }>): IntakeQuerier {
    return { query: mock(() => Promise.resolve(hits)) };
  }

  test('returns rows whose specPath is among the retrieved hits', async () => {
    const querier = fakeQuerier([{ sourcePath: 'docs/design/worker-mount-isolation.md', score: 0.9 }]);
    const matched = await matchRowsByDescription('ws1', 'fix the worker mount allowlist', rows, querier);
    expect(matched).toHaveLength(1);
    expect(matched[0].assertionId).toBe('mount-symbol');
  });

  test('a hit on an unrelated doc matches nothing', async () => {
    const querier = fakeQuerier([{ sourcePath: 'docs/design/unrelated-thing.md', score: 0.9 }]);
    expect(await matchRowsByDescription('ws1', 'something else entirely', rows, querier)).toEqual([]);
  });

  test('skips retrieval entirely for a blank description', async () => {
    const querier = fakeQuerier([]);
    const result = await matchRowsByDescription('ws1', '   ', rows, querier);
    expect(result).toEqual([]);
    expect(querier.query).not.toHaveBeenCalled();
  });

  test('skips retrieval entirely when there are no candidate rows', async () => {
    const querier = fakeQuerier([]);
    const result = await matchRowsByDescription('ws1', 'anything', [], querier);
    expect(result).toEqual([]);
    expect(querier.query).not.toHaveBeenCalled();
  });
});

describe('dedupeRows', () => {
  test('collapses rows sharing (specPath, assertionId) into one', () => {
    const a = row({ specPath: 'docs/design/x.md', assertionId: 'a' });
    const b = row({ specPath: 'docs/design/x.md', assertionId: 'a' });
    const c = row({ specPath: 'docs/design/y.md', assertionId: 'b' });
    expect(dedupeRows([a, b, c])).toHaveLength(2);
  });
});

describe('toWarning', () => {
  test('carries direction code_ahead and embeds the evidence detail in the message', () => {
    const w = toWarning(row({
      specPath: 'docs/design/x.md',
      assertionId: 'a',
      evidence: { detail: 'export of "Foo" found in apps/foo.ts' },
    }));
    expect(w.direction).toBe('code_ahead');
    expect(w.specPath).toBe('docs/design/x.md');
    expect(w.assertionId).toBe('a');
    expect(w.message).toContain('docs/design/x.md');
    expect(w.message).toContain('export of "Foo" found in apps/foo.ts');
  });
});

describe('findIntakeWarnings', () => {
  test('returns nothing and never calls the querier when the workspace has no open code_ahead rows', async () => {
    setStore([]);
    const querier: IntakeQuerier = { query: mock(() => Promise.resolve([])) };
    const result = await findIntakeWarnings({
      workspaceId: 'ws1',
      description: 'some new task about worker mounts',
      pathManifest: ['apps/runner/src/workers.ts'],
      querier,
    });
    expect(result).toEqual([]);
    expect(querier.query).not.toHaveBeenCalled();
  });

  test('warns via pathManifest match without needing a description', async () => {
    setStore([
      row({
        specPath: 'docs/design/worker-mount-isolation.md',
        assertionId: 'mount-symbol',
        evidence: { detail: 'export of "buildWorkerBwrapArgv" found in apps/runner/src/bwrap-mount-allowlist.ts' },
      }),
    ]);
    const querier: IntakeQuerier = { query: mock(() => Promise.resolve([])) };
    const result = await findIntakeWarnings({
      workspaceId: 'ws1',
      pathManifest: ['apps/runner/src/bwrap-mount-allowlist.ts'],
      querier,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      specPath: 'docs/design/worker-mount-isolation.md',
      assertionId: 'mount-symbol',
      direction: 'code_ahead',
    });
  });

  test('warns via description retrieval when pathManifest is absent', async () => {
    setStore([row({ specPath: 'docs/design/worker-mount-isolation.md', assertionId: 'mount-symbol' })]);
    const querier: IntakeQuerier = {
      query: mock(() => Promise.resolve([{ sourcePath: 'docs/design/worker-mount-isolation.md', score: 0.8 }])),
    };
    const result = await findIntakeWarnings({
      workspaceId: 'ws1',
      description: 'rebuild the worker mount allowlist from scratch',
      querier,
    });
    expect(result).toHaveLength(1);
    expect(result[0].assertionId).toBe('mount-symbol');
  });

  test('dedupes when both pathManifest and description match the same row', async () => {
    setStore([
      row({
        specPath: 'docs/design/worker-mount-isolation.md',
        assertionId: 'mount-symbol',
        evidence: { detail: 'export of "buildWorkerBwrapArgv" found in apps/runner/src/bwrap-mount-allowlist.ts' },
      }),
    ]);
    const querier: IntakeQuerier = {
      query: mock(() => Promise.resolve([{ sourcePath: 'docs/design/worker-mount-isolation.md', score: 0.8 }])),
    };
    const result = await findIntakeWarnings({
      workspaceId: 'ws1',
      description: 'touching the mount allowlist again',
      pathManifest: ['apps/runner/src/bwrap-mount-allowlist.ts'],
      querier,
    });
    expect(result).toHaveLength(1);
  });

  test('an unrelated task filed against a workspace with open rows gets no warnings', async () => {
    setStore([row({ specPath: 'docs/design/worker-mount-isolation.md', assertionId: 'mount-symbol' })]);
    const querier: IntakeQuerier = { query: mock(() => Promise.resolve([])) };
    const result = await findIntakeWarnings({
      workspaceId: 'ws1',
      description: 'add a new dashboard widget for release history',
      pathManifest: ['apps/web/src/app/app/(protected)/releases/page.tsx'],
      querier,
    });
    expect(result).toEqual([]);
  });
});
