import { describe, test, expect } from 'bun:test';
import { detectSpecConformanceRoots, detectMigrationsDir } from '../spec-conformance-detect';

describe('detectSpecConformanceRoots', () => {
  test('detects buildd-shaped docs/specs + docs/design', () => {
    const result = detectSpecConformanceRoots([
      'docs/specs/foo.md',
      'docs/design/bar.md',
      'packages/core/db/schema.ts',
    ]);
    expect(result).toEqual({ specsRoot: 'docs/specs', designRoot: 'docs/design' });
  });

  test('falls back to a bare spec/ or design/ convention', () => {
    const result = detectSpecConformanceRoots(['spec/api.md', 'design/architecture.md', 'src/index.ts']);
    expect(result).toEqual({ specsRoot: 'spec', designRoot: 'design' });
  });

  test('recognizes docs/adr as a design-equivalent root', () => {
    const result = detectSpecConformanceRoots(['docs/adr/0001-use-postgres.md']);
    expect(result.designRoot).toBe('docs/adr');
  });

  test('returns nulls for a repo with no docs tree at all', () => {
    const result = detectSpecConformanceRoots(['src/index.ts', 'README.md', 'package.json']);
    expect(result).toEqual({ specsRoot: null, designRoot: null });
  });

  test('does not match a file that merely starts with a candidate name', () => {
    // "specs.md" and "design-notes/" should not satisfy the "specs" / "design" directory candidates.
    const result = detectSpecConformanceRoots(['specs.md', 'design-notes/foo.md']);
    expect(result).toEqual({ specsRoot: null, designRoot: null });
  });

  test('prefers the more specific docs/specs over a bare specs/ when both exist', () => {
    const result = detectSpecConformanceRoots(['docs/specs/a.md', 'specs/b.md']);
    expect(result.specsRoot).toBe('docs/specs');
  });
});

describe('detectMigrationsDir', () => {
  test('finds generic candidates at any depth, shallowest first', () => {
    expect(detectMigrationsDir(['migrations/001.sql'])).toBe('migrations');
    expect(detectMigrationsDir(['db/migrate/1.rb'])).toBe('db/migrate');
    expect(detectMigrationsDir(['prisma/migrations/1/m.sql'])).toBe('prisma/migrations');
    expect(detectMigrationsDir(['services/api/alembic/env.py'])).toBe('services/api/alembic');
    expect(detectMigrationsDir(['a/migrations/1.sql', 'migrations/2.sql'])).toBe('migrations');
  });
  test('returns null when there is none, and does not match lookalike names', () => {
    expect(detectMigrationsDir(['src/index.ts', 'data-migrations-notes.md', 'premigrations/x'])).toBeNull();
    expect(detectMigrationsDir([])).toBeNull();
  });
});
