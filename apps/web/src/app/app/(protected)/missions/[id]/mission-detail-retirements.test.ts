/**
 * What slice S3 of docs/design/mission-feed-mobile-continuity.md retires, pinned
 * with `git grep` so nothing grows back: AC-15 (Rule L-4: one work-kind
 * classifier, `deriveWorkLane` gone), AC-16 (no "above ↑" copy, no dead
 * anchor), AC-2 (the flight-strip navigator's list has no importer) and the
 * page-bottom artifact dump (D5: records render once, in the Records sheet).
 *
 * Scoped to code (`apps/`, `packages/`): design docs quote the retired names
 * on purpose.
 */
import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const REPO = join(import.meta.dir, '../../../../../../../..');
const PAGE = join(import.meta.dir, 'page.tsx');

/** Paths matching a fixed-string `git grep` in code. Exit 1 = no match; anything else is a broken probe. */
function grep(args: string[]): string[] {
  const res = spawnSync('git', ['grep', '-l', ...args, '--', 'apps', 'packages'], { cwd: REPO, encoding: 'utf8' });
  if (res.status !== 0 && res.status !== 1) throw new Error(`git grep failed: ${res.stderr}`);
  return res.stdout.split('\n').filter(Boolean).filter(p => !p.endsWith('mission-detail-retirements.test.ts'));
}

describe('S3 retirements', () => {
  it('the probe can fail: it finds a symbol that does exist', () => {
    expect(grep(['-w', 'buildMissionFeedGroups']).length).toBeGreaterThan(0);
  });

  it('AC-15: deriveWorkLane and hasNoWorkLaneData are gone from code', () => {
    expect(grep(['-w', 'deriveWorkLane'])).toEqual([]);
    expect(grep(['-w', 'hasNoWorkLaneData'])).toEqual([]);
  });

  it('AC-16: no "See Goal Criteria above" copy and no #mission-goal-criteria anchor', () => {
    // Tests may name the strings to assert their absence from rendered markup.
    const shipped = (paths: string[]) => paths.filter(p => !/\.test\.tsx?$/.test(p));
    expect(shipped(grep(['-F', 'See Goal Criteria above']))).toEqual([]);
    expect(shipped(grep(['-F', '#mission-goal-criteria']))).toEqual([]);
  });

  it('AC-2: MissionFlightStripNav has no importer', () => {
    expect(grep(['-w', 'MissionFlightStripNav'])).toEqual([]);
  });

  it('D5: the mission page renders no unfiltered artifact dump and no progress card', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).not.toContain('id="mission-artifacts"');
    expect(src).not.toMatch(/import MissionArtifacts\b/);
    expect(src).not.toMatch(/import \{ MissionProgressBar \}/);
    expect(src).toContain('MissionRecordsSheet');
    expect(src).toContain('MissionDelivery');
  });

  it('the page no longer carries the Summary tab or its density switch', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).not.toContain('N_SMALL');
    expect(src).not.toContain('summaryContent');
    expect(src).not.toContain('feedContent');
  });

  it('F5: the description renders once, under the masthead; Settings only renames', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(/description=\{\s*<MissionDescription\b/);
    expect(src.split('<MissionDescription').length - 1).toBe(1);
    // Settings' editor no longer receives the description (or re-renders the title).
    expect(src).not.toMatch(/<MissionInlineEdit[^>]*initialDescription/);
  });
});
