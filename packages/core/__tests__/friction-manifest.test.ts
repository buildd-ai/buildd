import { describe, it, expect } from 'bun:test';
import { inferFrictionManifest } from '../friction-manifest';

describe('inferFrictionManifest', () => {
  // ── Step 1: extract paths from excerpt ───────────────────────────────────

  it('extracts a repo-relative path already in apps/ form', () => {
    const result = inferFrictionManifest(
      'enoent',
      "ENOENT: no such file or directory, open 'apps/web/src/lib/auth.ts'",
    );
    expect(result).toContain('apps/web/src/lib/auth.ts');
  });

  it('extracts a path starting with packages/', () => {
    const result = inferFrictionManifest(
      'enoent',
      "ENOENT: no such file or directory, open 'packages/core/db/schema.ts'",
    );
    expect(result).toContain('packages/core/db/schema.ts');
  });

  it('normalizes an absolute path to repo-relative form', () => {
    const result = inferFrictionManifest(
      'permission_denied',
      '/home/runner/project/apps/runner/src/env-scan.ts: Permission denied',
    );
    expect(result).toContain('apps/runner/src/env-scan.ts');
  });

  it('deduplicates the same path appearing twice in the excerpt', () => {
    const result = inferFrictionManifest(
      'git_fatal',
      'fatal: apps/web/src/lib/foo.ts: apps/web/src/lib/foo.ts not found',
    );
    expect(result).toEqual(['apps/web/src/lib/foo.ts']);
  });

  it('extracts multiple distinct paths from a multi-line excerpt', () => {
    const excerpt = [
      'fatal: could not open apps/runner/src/workers.ts',
      'error: apps/runner/src/git-operations.ts is locked',
    ].join('\n');
    const result = inferFrictionManifest('git_fatal', excerpt);
    expect(result).toContain('apps/runner/src/workers.ts');
    expect(result).toContain('apps/runner/src/git-operations.ts');
  });

  // ── bwrap fixture: env-scan.ts origin ────────────────────────────────────

  it('bwrap fixture: excerpt mentioning env-scan.ts yields that path', () => {
    const result = inferFrictionManifest(
      'bwrap_namespace_denied',
      'bwrap: No permissions to create a new namespace — from apps/runner/src/env-scan.ts',
    );
    expect(result).toContain('apps/runner/src/env-scan.ts');
  });

  // ── Step 2: fallback component table ─────────────────────────────────────

  it('returns fallback manifest when excerpt has no paths — bwrap_namespace_denied', () => {
    const result = inferFrictionManifest(
      'bwrap_namespace_denied',
      'bwrap: No permissions to create a new namespace',
    );
    expect(result).toEqual([
      'apps/runner/src/env-scan.ts',
      'apps/runner/src/workers.ts',
    ]);
  });

  it('fallback: oom_killed → workers.ts', () => {
    const result = inferFrictionManifest('oom_killed', 'Killed: 9');
    expect(result).toEqual(['apps/runner/src/workers.ts']);
  });

  it('fallback: git_fatal → git-operations.ts', () => {
    const result = inferFrictionManifest('git_fatal', 'fatal: not a git repository');
    expect(result).toEqual(['apps/runner/src/git-operations.ts']);
  });

  it('fallback: git_error → git-operations.ts', () => {
    const result = inferFrictionManifest('git_error', 'error: pathspec did not match any file');
    expect(result).toEqual(['apps/runner/src/git-operations.ts']);
  });

  it('fallback: enoent with no path in excerpt → empty array', () => {
    const result = inferFrictionManifest('enoent', 'ENOENT');
    expect(result).toEqual([]);
  });

  it('fallback: unknown pattern → empty array', () => {
    const result = inferFrictionManifest('totally_unknown_pattern', 'something went wrong');
    expect(result).toEqual([]);
  });

  it('fallback: empty excerpt with bwrap pattern → component table', () => {
    const result = inferFrictionManifest('bwrap_namespace_denied', '');
    expect(result).toEqual([
      'apps/runner/src/env-scan.ts',
      'apps/runner/src/workers.ts',
    ]);
  });
});
