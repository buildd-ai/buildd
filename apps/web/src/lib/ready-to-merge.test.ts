import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { decideReadyToMerge, readyToMergeReason } from './ready-to-merge';
import { deriveMissionVisualReview, type VisualReviewStateInput } from './workflow/visual-review-state';
import { resolveVisualReviewPolicy } from './workflow/visual-review-policy';

const input = (over: Partial<VisualReviewStateInput> = {}): VisualReviewStateInput => ({
  policy: resolveVisualReviewPolicy({}),
  uiChange: { state: 'yes', source: 'diff', uiFiles: 2 },
  audit: null,
  review: null,
  waiver: null,
  branch: { headSha: 'aaaa1111', base: 'dev', integrationPr: { number: 9, state: 'open', ready: true, blocked: false }, workLanded: true },
  ...over,
});
const audit = { id: 'a1', createdAt: '2026-10-01T00:00:00Z', errorType: null };
const reviewed = { phase: 'reviewed' as const, screens: 3, effectiveIssues: 0, awaitingHuman: 0, openFixes: 0, roundCapOpen: false, needsYouReason: null, captured: 0, expected: null };
const visual = (over: Partial<VisualReviewStateInput> = {}) => deriveMissionVisualReview(input(over));
const decide = (v: ReturnType<typeof visual> | null, workHolder: string | null = null) =>
  decideReadyToMerge({ kind: 'mission_integration_pr', workHolder, visual: v });

describe('decideReadyToMerge', () => {
  it('a PR that is not the mission integration PR is never asked (task PRs keep landing)', () => {
    expect(decideReadyToMerge({ kind: 'not_mission_pr' })).toEqual({ ready: true, blockers: [], scheduleVisualReview: false });
  });

  it('ready when the work is finished and the review passed on this head', () => {
    const v = visual({ audit, review: reviewed, auditedSha: 'aaaa1111' });
    expect(decide(v)).toMatchObject({ ready: true, blockers: [] });
  });

  it('owed review blocks and asks for it to be filed', () => {
    const d = decide(visual());
    expect(d).toMatchObject({ ready: false, scheduleVisualReview: true });
    expect(d.blockers[0]).toMatchObject({ code: 'visual_review_owed', nextActor: 'system' });
  });

  it('SHA invalidation: a pass on an older commit does not count and re-files', () => {
    const d = decide(visual({ audit, review: reviewed, auditedSha: 'old00000' }));
    expect(d.blockers.map(b => b.code)).toEqual(['visual_review_stale']);
    expect(d.scheduleVisualReview).toBe(true);
  });

  it('SHA invalidation: an audit that recorded no commit cannot prove same-commit evidence', () => {
    expect(decide(visual({ audit, review: reviewed, auditedSha: null })).blockers.map(b => b.code)).toEqual(['visual_review_stale']);
  });

  it('a stale pass does not block once the UI change is gone', () => {
    const v = visual({ audit, review: reviewed, auditedSha: 'old00000', uiChange: { state: 'no', source: null, uiFiles: 0 } });
    expect(decide(v).ready).toBe(true);
  });

  it('open findings block and are not re-filed over: the findings loop owns them', () => {
    const d = decide(visual({ audit, review: { ...reviewed, phase: 'fixing', effectiveIssues: 1, openFixes: 1 }, auditedSha: 'aaaa1111' }));
    expect(d.blockers[0]).toMatchObject({ code: 'visual_review_findings', nextActor: 'system' });
    expect(d.scheduleVisualReview).toBe(false);
  });

  it('after the fix merges the head moves, the pass is stale and the review re-runs before merge', () => {
    const fixed = visual({ audit, review: reviewed, auditedSha: 'aaaa1111', branch: { ...input().branch, headSha: 'bbbb2222' } });
    expect(decide(fixed).blockers.map(b => b.code)).toEqual(['visual_review_stale']);
  });

  it('browser unavailable is blocked with the owner as next actor, not retried', () => {
    const d = decide(visual({
      audit, review: { ...reviewed, phase: 'no_browser_runner' }, auditedSha: 'aaaa1111',
      captureConfigError: 'app_auth_not_configured',
    }));
    expect(d.blockers[0]).toMatchObject({ code: 'visual_review_blocked', nextActor: 'owner' });
    expect(d.scheduleVisualReview).toBe(false);
  });

  it('a system failure with retries left stays with the system', () => {
    const d = decide(visual({ audit, review: { ...reviewed, phase: 'failed' }, auditedSha: 'aaaa1111', autoRetriesLeft: 2 }));
    expect(d.blockers[0]).toMatchObject({ code: 'visual_review_blocked', nextActor: 'system' });
  });

  it('the same failure with no retries left goes to the owner', () => {
    const d = decide(visual({ audit, review: { ...reviewed, phase: 'failed' }, auditedSha: 'aaaa1111', autoRetriesLeft: 0 }));
    expect(d.blockers[0]).toMatchObject({ nextActor: 'owner' });
  });

  it('a recorded waiver clears it, except under strict where waivers are not allowed', () => {
    const waiver = { reason: 'copy-only', actorLabel: 'someone', at: '2026-10-02T00:00:00Z' };
    expect(decide(visual({ waiver })).ready).toBe(true);
    expect(decide(visual({ waiver, policy: resolveVisualReviewPolicy({ workspace: 'strict' }) })).ready).toBe(false);
  });

  it('policy off needs no review', () => {
    expect(decide(visual({ policy: resolveVisualReviewPolicy({ workspace: 'off' }) })).ready).toBe(true);
  });

  it('a mission PR that already merged is recovery, never a pre-merge block', () => {
    const merged = visual({ branch: { ...input().branch, integrationPr: { number: 9, state: 'merged', ready: true, blocked: false } } });
    expect(merged.branch.postMergeRecovery).toBe(true);
    expect(decide(merged).ready).toBe(true);
  });

  it('unfinished work blocks even with a passing review, and says why', () => {
    const d = decide(visual({ audit, review: reviewed, auditedSha: 'aaaa1111' }), 'two task PRs still open');
    expect(d.blockers.map(b => b.code)).toEqual(['work_unfinished']);
    expect(readyToMergeReason(d)).toContain('two task PRs still open');
  });

  it('fails closed when the review state cannot be read', () => {
    expect(decide(null).blockers.map(b => b.code)).toEqual(['visual_state_unreadable']);
  });
});

// Every door that can land a PR must reach the mission gate. A new door that calls a merge
// primitive without it fails here, naming the file, rather than shipping an unguarded path.
describe('every merge door consults the mission gate', () => {
  const root = join(import.meta.dir, '..');
  const read = (rel: string) => readFileSync(join(root, rel), 'utf8');
  const doors: Array<[string, string]> = [
    ['auto-merge', 'lib/auto-merge.ts'],
    ['kernel landing (landPr)', 'lib/pr-landing.ts'],
    ['merge_pr MCP', 'app/api/github/pr/route.ts'],
    ['dashboard merge button', 'app/api/prs/[prNumber]/merge/route.ts'],
  ];
  for (const [name, file] of doors) {
    it(`${name} calls guardMissionPrMerge before it merges`, () => {
      const src = read(file);
      const guard = src.indexOf('await guardMissionPrMerge(');
      expect(guard).toBeGreaterThan(-1);
      const merge = Math.min(...['landThroughKernel(', 'kernelLand(', 'mergePullRequest('].map(m => {
        const at = src.indexOf(m, guard);
        return at === -1 ? Infinity : at;
      }));
      expect(merge).toBeGreaterThan(guard);
    });
  }

  it('any other file that merges a PR is a known non-mission door', () => {
    const allowed = new Set([
      'lib/github.ts', // the primitive
      'lib/surface-ordering-door.ts', // names it in a doc comment; it wraps a door's own call
      'lib/workflow/pr-landing-effects.ts', // the kernel's merge_call, reached only through landPr
      'lib/workflow/landing.ts', 'lib/workflow/seam.ts',
      'lib/workflow/command-api.ts', // the control plane's command endpoint: runs the seam's landThroughKernel for a door that already passed its gates
      'lib/release-executor.ts', // dev -> main release PRs, not a mission integration PR
      'lib/release/compose-runtime.ts', // binds the release executor's merge; dev -> main release PRs only
      'lib/release/pinned-merge.ts', // the release doors' pinned merge (D8-D10): release PRs, review gate at the verified head
      'lib/held-pr-tasks.ts', // release-pr ci-success (the webhook and the held-release sweep) only
      ...doors.map(d => d[1]),
    ]);
    const { execSync } = require('node:child_process') as typeof import('node:child_process');
    const files = execSync(`grep -rlE "mergePullRequest\\(|landThroughKernel\\(" --include=*.ts . || true`, { cwd: root, encoding: 'utf8' })
      .split('\n').map(f => f.replace(/^\.\//, '')).filter(f => f && !/\.test\.ts$/.test(f));
    const unknown = files.filter(f => !allowed.has(f));
    expect(unknown).toEqual([]);
  });
});
