/**
 * Tests for change-intent helpers.
 *
 * Covers:
 *  - matchesSurface()         — pure surface-pattern matching
 *  - resolveMatchedSurfaces() — pattern resolution against workspace config
 *  - resolveAnchorInjections() — sequence-namespace anchor injection
 *
 * DB-touching functions (recordChangeIntents, closeIntentsForPr, etc.) are
 * integration-tested via the PR route tests; only pure functions are unit-tested here.
 *
 * Run: bun test apps/web/src/lib/change-intent.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  matchesSurface,
  resolveMatchedSurfaces,
  resolveAnchorInjections,
} from './change-intent';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';

// ─── matchesSurface ──────────────────────────────────────────────────────────

describe('matchesSurface', () => {
  test('exact match', () => {
    expect(matchesSurface('bun.lock', 'bun.lock')).toBe(true);
  });

  test('exact match with subpath: no match', () => {
    expect(matchesSurface('bun.lock.backup', 'bun.lock')).toBe(false);
  });

  test('prefix directory match: pattern is a parent directory', () => {
    expect(matchesSurface('packages/core/drizzle/0106_foo.sql', 'packages/core/drizzle')).toBe(true);
  });

  test('prefix directory match: path equals pattern (directory itself)', () => {
    expect(matchesSurface('packages/core/drizzle', 'packages/core/drizzle')).toBe(true);
  });

  test('glob suffix pattern: matches path under the prefix', () => {
    expect(matchesSurface('packages/core/drizzle/0106_foo.sql', 'packages/core/drizzle/**')).toBe(true);
  });

  test('glob suffix pattern: matches nested path', () => {
    expect(matchesSurface('packages/core/drizzle/meta/_journal.json', 'packages/core/drizzle/**')).toBe(true);
  });

  test('glob suffix pattern: no match for sibling directory', () => {
    expect(matchesSurface('packages/core/drizzle2/0001_foo.sql', 'packages/core/drizzle/**')).toBe(false);
  });

  test('no partial word match: schema.ts does not match schema', () => {
    expect(matchesSurface('packages/core/db/schema.ts', 'packages/core/db/schema')).toBe(false);
  });

  test('exact file match works', () => {
    expect(matchesSurface('packages/core/db/schema.ts', 'packages/core/db/schema.ts')).toBe(true);
  });
});

// ─── resolveMatchedSurfaces ──────────────────────────────────────────────────

const SAMPLE_CONFIG: Partial<WorkspaceGitConfig> = {
  conflictSurfaces: [
    { pattern: 'packages/core/drizzle/**', label: 'Drizzle migrations' },
    { pattern: 'packages/core/db/schema.ts', label: 'DB schema' },
    { pattern: 'bun.lock', label: 'lockfile' },
  ],
};

describe('resolveMatchedSurfaces', () => {
  test('returns empty when no conflict surfaces configured', () => {
    expect(resolveMatchedSurfaces(['bun.lock'], null)).toEqual([]);
  });

  test('returns empty when pathManifest is empty', () => {
    expect(resolveMatchedSurfaces([], SAMPLE_CONFIG as WorkspaceGitConfig)).toEqual([]);
  });

  test('matches Drizzle migration file to the migration surface', () => {
    const surfaces = resolveMatchedSurfaces(
      ['packages/core/drizzle/0106_foo.sql'],
      SAMPLE_CONFIG as WorkspaceGitConfig,
    );
    expect(surfaces).toContain('Drizzle migrations');
    expect(surfaces).not.toContain('DB schema');
  });

  test('matches schema.ts exactly', () => {
    const surfaces = resolveMatchedSurfaces(
      ['packages/core/db/schema.ts'],
      SAMPLE_CONFIG as WorkspaceGitConfig,
    );
    expect(surfaces).toContain('DB schema');
  });

  test('matches multiple surfaces when pathManifest spans both', () => {
    const surfaces = resolveMatchedSurfaces(
      ['packages/core/db/schema.ts', 'packages/core/drizzle/0106_foo.sql'],
      SAMPLE_CONFIG as WorkspaceGitConfig,
    );
    expect(surfaces).toContain('DB schema');
    expect(surfaces).toContain('Drizzle migrations');
  });

  test('each label returned at most once even if multiple paths match the same surface', () => {
    const surfaces = resolveMatchedSurfaces(
      ['packages/core/drizzle/0106_foo.sql', 'packages/core/drizzle/meta/_journal.json'],
      SAMPLE_CONFIG as WorkspaceGitConfig,
    );
    expect(surfaces.filter(s => s === 'Drizzle migrations').length).toBe(1);
  });

  test('unrelated paths return empty', () => {
    const surfaces = resolveMatchedSurfaces(
      ['apps/web/src/lib/foo.ts'],
      SAMPLE_CONFIG as WorkspaceGitConfig,
    );
    expect(surfaces).toEqual([]);
  });
});

// ─── resolveAnchorInjections ─────────────────────────────────────────────────

const NAMESPACE_CONFIG: Partial<WorkspaceGitConfig> = {
  sequenceNamespaces: [
    {
      dir: 'packages/core/drizzle',
      anchorFile: 'packages/core/drizzle/meta/_journal.json',
      label: 'Drizzle migrations',
    },
  ],
};

describe('resolveAnchorInjections', () => {
  test('no injection when config has no sequenceNamespaces', () => {
    const result = resolveAnchorInjections(['packages/core/db/schema.ts'], null);
    expect(result).toEqual([]);
  });

  test('no injection when pathManifest is empty', () => {
    const result = resolveAnchorInjections([], NAMESPACE_CONFIG as WorkspaceGitConfig);
    expect(result).toEqual([]);
  });

  test('injects anchorFile when pathManifest touches the namespace dir', () => {
    const result = resolveAnchorInjections(
      ['packages/core/db/schema.ts', 'packages/core/drizzle/0106_foo.sql'],
      NAMESPACE_CONFIG as WorkspaceGitConfig,
    );
    expect(result).toContain('packages/core/drizzle/meta/_journal.json');
  });

  test('does not inject anchorFile when it is already in the pathManifest', () => {
    const result = resolveAnchorInjections(
      ['packages/core/drizzle/0106_foo.sql', 'packages/core/drizzle/meta/_journal.json'],
      NAMESPACE_CONFIG as WorkspaceGitConfig,
    );
    expect(result).toEqual([]); // already present — no duplicate
  });

  test('does not inject for unrelated paths', () => {
    const result = resolveAnchorInjections(
      ['apps/web/src/lib/foo.ts'],
      NAMESPACE_CONFIG as WorkspaceGitConfig,
    );
    expect(result).toEqual([]);
  });

  test('two concurrent migration tasks both get anchor injection', () => {
    // Simulates the core fix: task A and task B both declare a migration file.
    // Both get _journal.json injected, making their manifests overlap — which
    // the claim route's findBlockingPr() catches and serialises.
    const taskAManifest = ['packages/core/db/schema.ts', 'packages/core/drizzle/0106_taskA.sql'];
    const taskBManifest = ['packages/core/db/schema.ts', 'packages/core/drizzle/0106_taskB.sql'];

    const aInjections = resolveAnchorInjections(taskAManifest, NAMESPACE_CONFIG as WorkspaceGitConfig);
    const bInjections = resolveAnchorInjections(taskBManifest, NAMESPACE_CONFIG as WorkspaceGitConfig);

    // Both get the anchor file injected
    expect(aInjections).toContain('packages/core/drizzle/meta/_journal.json');
    expect(bInjections).toContain('packages/core/drizzle/meta/_journal.json');

    // After injection both manifests include _journal.json → pathsOverlap returns true
    const { pathsOverlap } = require('@buildd/core/path-overlap');
    const fullA = [...taskAManifest, ...aInjections];
    const fullB = [...taskBManifest, ...bInjections];
    expect(pathsOverlap(fullA, fullB)).toBe(true);
  });
});

// ─── Schema-only trigger + NULL-safe exclusion (conflict-aware-orchestration §3) ─

import { PgDialect } from 'drizzle-orm/pg-core';
import { conflictingIntentsWhere, intentInsertIfAbsentSql } from './change-intent';

const NS_CONFIG = {
  sequenceNamespaces: [{
    dir: 'packages/core/drizzle',
    anchorFile: 'packages/core/drizzle/meta/_journal.json',
    label: 'Drizzle migrations',
    triggers: ['packages/core/db/schema.ts'],
  }],
} as unknown as WorkspaceGitConfig;

describe('resolveAnchorInjections — schema triggers', () => {
  test('a schema-only manifest gets the namespace anchor', () => {
    expect(resolveAnchorInjections(['packages/core/db/schema.ts'], NS_CONFIG)).toEqual(['packages/core/drizzle/meta/_journal.json']);
  });

  test('a manifest directory containing the trigger gets the anchor', () => {
    expect(resolveAnchorInjections(['packages/core/db'], NS_CONFIG)).toEqual(['packages/core/drizzle/meta/_journal.json']);
  });

  test('no trigger configured: schema-only manifest gets nothing (unchanged default)', () => {
    const cfg = { sequenceNamespaces: [{ dir: 'packages/core/drizzle', anchorFile: 'packages/core/drizzle/meta/_journal.json', label: 'm' }] } as unknown as WorkspaceGitConfig;
    expect(resolveAnchorInjections(['packages/core/db/schema.ts'], cfg)).toEqual([]);
  });

  test('unrelated manifest gets nothing', () => {
    expect(resolveAnchorInjections(['apps/web/src/a.ts'], NS_CONFIG)).toEqual([]);
  });
});

describe('conflictingIntentsWhere', () => {
  const dialect = new PgDialect();
  test('excluding a task keeps rows whose task id is NULL (SQL <> drops NULL)', () => {
    const q = dialect.sqlToQuery(conflictingIntentsWhere('ws-1', ['s'], 'task-1'));
    expect(q.sql).toContain('"change_intents"."workspace_id" = $1');
    expect(q.sql).toContain('"change_intents"."closed_at" is null');
    expect(q.sql).toMatch(/\("change_intents"\."task_id" is null or "change_intents"\."task_id" <> \$\d\)/);
  });

  test('no exclusion: no task predicate at all', () => {
    const q = dialect.sqlToQuery(conflictingIntentsWhere('ws-1', ['s'], null));
    expect(q.sql).not.toContain('task_id');
  });
});

describe('intentInsertIfAbsentSql', () => {
  test('one statement, guarded by NOT EXISTS on an open row for the same workspace, PR and surface', () => {
    const q = new PgDialect().sqlToQuery(intentInsertIfAbsentSql({ workspaceId: 'ws-1', surface: 'lockfile', taskId: null, prNumber: 7, branch: 'b', headSha: 'h' }));
    expect(q.sql).toMatch(/^INSERT INTO "change_intents"/);
    expect(q.sql).toMatch(/WHERE NOT EXISTS/);
    expect(q.sql).toMatch(/ci\.workspace_id = \$\d+::uuid AND ci\.pr_number = \$\d+::int\s+AND ci\.surface = \$\d+ AND ci\.closed_at IS NULL/);
    expect(q.params).toEqual(['ws-1', 'lockfile', null, 7, 'b', 'h', 'ws-1', 7, 'lockfile']);
  });
});
