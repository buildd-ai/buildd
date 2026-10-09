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
import { existsSync, readFileSync } from 'node:fs';
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
    // The Delivery stepper went with the legacy Feed; the band says what it said.
    expect(src).not.toContain('<MissionDelivery');
  });

  it('F6: the mission page carries no workspace release queue and no Release now trigger', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(grep(['-w', 'ReleaseNowButton'])).toEqual([]);
    expect(src).not.toContain('deriveReleaseNowState');
    expect(src).not.toContain('vercel_token');
    // The Shipped row is a footer row now, fed the Shipped step.
    expect(src).toMatch(/<MissionReleaseSection step=\{shippedStep\}/);
  });

  it('F6: the Shipped link opens the release that carries this mission, not the workspace\'s latest', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toContain('loadMissionCarryingReleaseId(');
    expect(src).not.toMatch(/releaseId=\{releaseFooterData/);
  });

  it('the Delivery glyph colours have one definition, shared by every step row', () => {
    for (const file of ['MissionScreensRow.tsx', 'MissionReleaseSection.tsx']) {
      const src = readFileSync(join(import.meta.dir, file), 'utf8');
      expect(src).not.toMatch(/const STATE_TEXT\b/);
      expect(src).toContain('DELIVERY_STATE_TEXT');
    }
  });

  it('the page no longer carries the Summary tab or its density switch', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).not.toContain('N_SMALL');
    expect(src).not.toContain('summaryContent');
    expect(src).not.toContain('feedContent');
  });

  it('F5: the description renders once, behind the header\'s Description; Settings only renames', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toMatch(/description=\{mission\.description \|\| !isTerminal \? <MissionDescription\b/);
    expect(src.split('<MissionDescription').length - 1).toBe(1);
    // Settings' editor no longer receives the description (or re-renders the title).
    expect(src).not.toMatch(/<MissionInlineEdit[^>]*initialDescription/);
  });
});

describe('Visual review retirements (docs/design/visual-qa-human-review.md, "Where it shows")', () => {
  const RETIRED = ['MissionDelivery', 'BoardVisualShots', 'VisualReviewLightbox', 'VisualReviewStrip'];

  it('the replaced components are gone from the mission folder', () => {
    for (const name of [...RETIRED, 'visual-review-parts']) {
      expect(existsSync(join(import.meta.dir, `${name}.tsx`))).toBe(false);
    }
    expect(existsSync(join(import.meta.dir, 'MissionDelivery.test.tsx'))).toBe(false);
    expect(existsSync(join(import.meta.dir, 'VisualReviewStrip.test.tsx'))).toBe(false);
  });

  it('nothing imports them', () => {
    for (const name of RETIRED) {
      expect(grep(['-E', `from ['"][^'"]*/${name}['"]`])).toEqual([]);
    }
    expect(grep(['-F', 'visual-review-parts'])).toEqual([]);
  });

  it('the page passes the model whenever an audit exists: no shots-only guard', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toContain('loadVisualReview(');
    expect(src).not.toMatch(/visualRun\.length\s*>\s*0/);
    expect(src).not.toMatch(/run\.length\s*>\s*0/);
    // The Board and the Feed get the one model, and so does the review provider.
    expect(src).toMatch(/<MissionBoard [^>]*visual=\{boardVisual\}/);
    expect(src).toMatch(/<MissionFeedLayout[^>]*visual=\{boardVisual\}/s);
    expect(src.match(/visual=\{boardVisual\}/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
  });

  it('the footer renders the Screens row next to Shipped, inside the review provider', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toContain('<MissionScreensRow missionId={id} step={visualStep} />');
    expect(src.indexOf('<MissionReleaseSection')).toBeLessThan(src.indexOf('<MissionScreensRow'));
    expect(src).toContain('<MissionVisualReviewProvider missionId={id} visual={boardVisual}>');
  });

  it('the Settings sheet carries the auto-audit switch, read from the mission row', () => {
    const src = readFileSync(PAGE, 'utf8');
    expect(src).toContain('<MissionVisualReviewSetting');
    expect(src).toMatch(/autoSurfaceAudit/);
  });
});
