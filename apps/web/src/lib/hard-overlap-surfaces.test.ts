/**
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/hard-overlap-surfaces.test.ts
 */
import { describe, it, expect } from 'bun:test';
import {
  matchesGitattributesPattern,
  resolveHardOverlapSurfaces as resolveWith,
  isHardOverlapSurface as isHardWith,
  overlapIsHard as overlapIsHardWith,
} from './hard-overlap-surfaces';
import { resolveSerializedSurfaces } from './surface-ordering-config';
import { classifyManifestOverlap } from '@buildd/core/path-overlap';

const resolveHardOverlapSurfaces = (paths: string[], gitConfig: any) => resolveWith(paths, gitConfig, resolveSerializedSurfaces);
const isHardOverlapSurface = (paths: string[], gitConfig: any) => isHardWith(paths, gitConfig, resolveSerializedSurfaces);
const overlapIsHard = (paths: string[], kind: any, gitConfig: any) => overlapIsHardWith(paths, kind, gitConfig, resolveSerializedSurfaces);

describe('matchesGitattributesPattern', () => {
  it.each([
    ['bun.lock', 'bun.lock', true],
    ['apps/web/bun.lock', 'bun.lock', true],
    ['apps/web/bun.lock', '/bun.lock', false],
    ['bun.lock', '/bun.lock', true],
    ['docs/specs/INDEX.md', 'docs/specs/INDEX.md', true],
    ['other/docs/specs/INDEX.md', 'docs/specs/INDEX.md', false],
    ['src/gen/a.pb.ts', '*.pb.ts', true],
    ['src/gen/a.pb.ts', 'src/*.pb.ts', false],
    ['src/gen/a.pb.ts', 'src/**/*.pb.ts', true],
    ['src/gen/a.ts', 'src/gen/**', true],
  ] as const)('%s ~ %s → %s', (path, pattern, want) => {
    expect(matchesGitattributesPattern(path, pattern)).toBe(want);
  });
});

describe('resolveHardOverlapSurfaces', () => {
  const gitConfig = {
    derivedFiles: [{ glob: '/bun.lock', regenerate: 'bun install' }],
    overlapHotspots: ['apps/web/src/app/api/workers/claim/route.ts', 'packages/core/hot/**'],
    sequenceNamespaces: [{ label: 'migrations', dir: 'db/migrations/', anchorFile: 'db/migrations/meta.json', serialize: true }],
  } as any;

  it('an ordinary same-file overlap is not a hard surface', () => {
    expect(resolveHardOverlapSurfaces(['apps/web/src/lib/explain.ts'], gitConfig)).toEqual([]);
    expect(isHardOverlapSurface(['apps/web/src/lib/explain.ts'], gitConfig)).toBe(false);
  });

  it('a generated file (built-in regenerable or workspace derivedFiles) is hard', () => {
    expect(resolveHardOverlapSurfaces(['docs/specs/INDEX.md'], null)).toEqual(['generated:docs/specs/INDEX.md']);
    expect(resolveHardOverlapSurfaces(['bun.lock'], gitConfig)).toEqual(['generated:/bun.lock']);
  });

  it('an explicit hotspot is hard', () => {
    expect(resolveHardOverlapSurfaces(['apps/web/src/app/api/workers/claim/route.ts'], gitConfig)).toEqual(['hotspot:apps/web/src/app/api/workers/claim/route.ts']);
    expect(resolveHardOverlapSurfaces(['packages/core/hot/x.ts'], gitConfig)).toEqual(['hotspot:packages/core/hot/**']);
  });

  it('a serialized surface is hard', () => {
    expect(resolveHardOverlapSurfaces(['db/migrations/0001.sql'], gitConfig)).toContain('serialized:migrations');
  });

  it('a malformed config fails closed (hard)', () => {
    const bad = { overlapHotspots: 'not-a-list', conflictSurfaces: 7 } as any;
    expect(isHardOverlapSurface(['a/b.ts'], bad)).toBe(true);
  });
});

describe('overlapIsHard: generated and hotspot files are hard only for a same-file overlap', () => {
  const gitConfig = {
    overlapHotspots: ['apps/web/src/hot.ts'],
    conflictSurfaces: [{ label: 'scripts', pattern: 'scripts', serialize: true }],
  } as any;

  it('same file on a generated file or hotspot → hard', () => {
    expect(overlapIsHard(['docs/specs/INDEX.md'], 'exact_file', gitConfig)).toBe(true);
    expect(overlapIsHard(['apps/web/src/hot.ts'], 'exact_file', gitConfig)).toBe(true);
  });

  it('a directory overlap that merely contains one stays soft', () => {
    expect(overlapIsHard(['docs/specs', 'docs/specs/INDEX.md'], 'prefix', gitConfig)).toBe(false);
    expect(overlapIsHard(['apps/web/src', 'apps/web/src/hot.ts'], 'prefix', gitConfig)).toBe(false);
  });

  it('a serialized surface is hard for any overlap kind', () => {
    expect(overlapIsHard(['scripts', 'scripts/x.ts'], 'prefix', gitConfig)).toBe(true);
  });

  it('an ordinary same-file overlap is soft; a malformed config is hard', () => {
    expect(overlapIsHard(['apps/web/src/lib/x.ts'], 'exact_file', gitConfig)).toBe(false);
    expect(overlapIsHard(['apps/web/src/lib/x.ts'], 'exact_file', { overlapHotspots: 'x' } as any)).toBe(true);
  });
});

describe('review finding: a same-file pair is judged on its whole overlap', () => {
  it('A: seq-dir/ + src/a.ts vs B: seq-dir/0042.ts + src/a.ts stays hard on a serialized seq-dir', () => {
    const cfg = { sequenceNamespaces: [{ label: 'seq', dir: 'seq-dir/', anchorFile: 'seq-dir/meta.json', serialize: true }] } as any;
    const o = classifyManifestOverlap(['seq-dir/', 'src/a.ts'], ['seq-dir/0042.ts', 'src/a.ts']);
    expect(o.kind).toBe('exact_file');
    expect(overlapIsHard(o.paths, o.kind, cfg)).toBe(true);
  });
});
