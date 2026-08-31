/**
 * Unit test: the artifact-type vocabulary is single-sourced.
 *
 * Regression for C16: four writer sites each carried their own accepted-type set
 * (17 / 12 / 8 / 6) plus a fifth in a test, so the same `create_artifact` call
 * succeeded or 400'd depending on which route it landed on. Every writer must
 * validate against `ARTIFACT_TYPES` in @buildd/shared and nothing else.
 *
 * The check is textual on purpose: importing the route modules drags in Next.js
 * request plumbing and a DB client, and what we need to pin is that no second
 * hand-written list reappears.
 */

import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ARTIFACT_TYPES,
  ARTIFACT_TYPE_LABELS,
  ArtifactType,
  isArtifactType,
} from '@buildd/shared';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..');
const read = (rel: string) => readFileSync(join(REPO_ROOT, rel), 'utf8');

/** Every site that decides whether an artifact type is acceptable. */
const WRITER_SITES = [
  'apps/web/src/app/api/workers/[id]/artifacts/route.ts',
  'apps/web/src/app/api/missions/[id]/artifacts/route.ts',
  'apps/web/src/app/api/initiatives/[id]/artifacts/route.ts',
  'apps/web/src/app/api/artifacts/upload-url/route.ts',
  'packages/core/mcp-tools.ts',
];

describe('artifact-type vocabulary', () => {
  test('ARTIFACT_TYPES is exactly the ArtifactType values', () => {
    expect([...ARTIFACT_TYPES].sort()).toEqual(Object.values(ArtifactType).sort());
    // Duplicate-proof: a copy/paste slip in the enum would shrink the Set.
    expect(new Set(ARTIFACT_TYPES).size).toBe(ARTIFACT_TYPES.length);
  });

  test('isArtifactType accepts every known type and rejects unknowns', () => {
    for (const t of ARTIFACT_TYPES) expect(isArtifactType(t)).toBe(true);
    expect(isArtifactType('not_a_type')).toBe(false);
    expect(isArtifactType('')).toBe(false);
    expect(isArtifactType(undefined)).toBe(false);
    expect(isArtifactType(null)).toBe(false);
    expect(isArtifactType(42)).toBe(false);
  });

  test('every type has a UI label — the label map is not a second vocabulary', () => {
    expect(Object.keys(ARTIFACT_TYPE_LABELS).sort()).toEqual([...ARTIFACT_TYPES].sort());
  });

  test('no writer site declares its own accepted-type list', () => {
    const offenders: string[] = [];
    for (const rel of WRITER_SITES) {
      const src = read(rel);
      // A hand-rolled vocabulary looks like a literal list of >=2 snake_case
      // artifact-type strings. Help text is prose, so only code lists match.
      const listLiteral = /\[\s*(['"])(?:content|report|data|link|summary|file|analysis|recommendation|alert|email_draft|social_post|calendar_event|impl_plan|screenshot|recording|diff|walkthrough)\1\s*,/;
      if (listLiteral.test(src)) offenders.push(rel);
    }
    expect(offenders).toEqual([]);
  });

  test('every writer site validates against the shared vocabulary', () => {
    const missing = WRITER_SITES.filter(rel => !/isArtifactType|ARTIFACT_TYPES/.test(read(rel)));
    expect(missing).toEqual([]);
  });

  test('the artifact detail page derives its labels from the shared map', () => {
    const src = read('apps/web/src/app/app/(protected)/artifacts/[id]/page.tsx');
    expect(src).toContain('ARTIFACT_TYPE_LABELS');
    // The old duplicated table keyed labels per type inline.
    expect(src).not.toContain("label: 'Calendar Event'");
  });
});
