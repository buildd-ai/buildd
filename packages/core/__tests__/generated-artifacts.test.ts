import { describe, expect, test } from 'bun:test';
import { isCiVerifiedGeneratedPath, isGeneratedArtifactPath } from '../generated-artifacts';

describe('generated artifacts', () => {
  test('CI regenerates and compares the specs index and the drizzle journal and snapshots', () => {
    expect(isCiVerifiedGeneratedPath('docs/specs/INDEX.md')).toBe(true);
    expect(isCiVerifiedGeneratedPath('packages/core/drizzle/meta/_journal.json')).toBe(true);
    expect(isCiVerifiedGeneratedPath('packages/core/drizzle/meta/0290_snapshot.json')).toBe(true);
  });
  test('a migration .sql is generated but not CI-verified: a hand-written step passes the up-to-date check', () => {
    expect(isGeneratedArtifactPath('packages/core/drizzle/0290_fat_hemingway.sql')).toBe(true);
    expect(isCiVerifiedGeneratedPath('packages/core/drizzle/0290_fat_hemingway.sql')).toBe(false);
  });
  test('v1 folders: the snapshot is regenerated and CI-verified, the migration.sql is generated but still reviewed', () => {
    const dir = 'packages/core/drizzle/20261012120000_add_busy_since/';
    expect(isCiVerifiedGeneratedPath(`${dir}snapshot.json`)).toBe(true);
    expect(isGeneratedArtifactPath(`${dir}snapshot.json`)).toBe(true);
    expect(isGeneratedArtifactPath(`${dir}migration.sql`)).toBe(true);
    expect(isCiVerifiedGeneratedPath(`${dir}migration.sql`)).toBe(false);
    expect(isCiVerifiedGeneratedPath('packages/core/drizzle/20261012120000_x/notes.json')).toBe(false);
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
