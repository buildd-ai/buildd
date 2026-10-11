import { describe, expect, test } from 'bun:test';
import { isCiVerifiedGeneratedPath, isGeneratedArtifactPath } from '../generated-artifacts';

describe('generated artifacts', () => {
  test('CI regenerates and compares the specs index and every drizzle file', () => {
    expect(isCiVerifiedGeneratedPath('docs/specs/INDEX.md')).toBe(true);
    expect(isCiVerifiedGeneratedPath('packages/core/drizzle/meta/_journal.json')).toBe(true);
    expect(isCiVerifiedGeneratedPath('packages/core/drizzle/0290_fat_hemingway.sql')).toBe(true);
  });
  test('the design-check baseline is generated but only ratcheted, so not CI-verified', () => {
    expect(isGeneratedArtifactPath('scripts/design-check.baseline.json')).toBe(true);
    expect(isCiVerifiedGeneratedPath('scripts/design-check.baseline.json')).toBe(false);
  });
  test('hand-written files are neither, including look-alikes', () => {
    for (const p of ['packages/core/db/schema.ts', 'docs/specs/INDEX.md.bak', 'docs/specs/mission-feed.md', 'packages/core/drizzle-kit.ts']) {
      expect(isGeneratedArtifactPath(p)).toBe(false);
    }
  });
});
