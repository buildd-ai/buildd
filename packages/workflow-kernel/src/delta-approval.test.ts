/**
 * deltaApprovalEligibility (58c8961e): when may the round after an approval
 * be a delta review that carries it? Every "no" here is a full review.
 */
import { describe, expect, test } from 'bun:test';
import { DELTA_MAX_FILES, DELTA_MAX_LINES, deltaApprovalEligibility, deltaApprovalSource, isTestOrConfigPath, type DeltaReading } from './delta-approval';
import type { DeliverySnapshot, FindingSnapshot, KernelView, RoundSnapshot } from './types';

const D = (o: Partial<DeliverySnapshot> = {}): DeliverySnapshot => ({
  id: 'd1', workspaceId: 'w1', ownerTaskId: 't1', repoFullName: 'acme/widgets', prNumber: 7, baseRef: 'dev',
  state: 'APPROVED', stateReason: null, version: 5, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3,
  boundAttemptId: null, resumeState: null, trunkIncidentId: null, approvedHeads: ['H1'], approvalBasis: 'verdict',
  compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null, mergeableHeadSha: null, mergedAt: null,
  mergeCommitSha: null, supersededByPr: null, ...o,
});
const approved = (o: Partial<RoundSnapshot> = {}): RoundSnapshot => ({
  id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0, ...o,
});
const V = (o: { d?: Partial<DeliverySnapshot>; rounds?: RoundSnapshot[]; findings?: FindingSnapshot[] } = {}): KernelView => ({
  delivery: D(o.d), rounds: o.rounds ?? [approved()], attempts: [], findings: o.findings ?? [],
});
const reading = (o: Partial<DeltaReading> = {}): DeltaReading => ({
  fromHeadSha: 'H1', toHeadSha: 'H2', prFilesAtFrom: ['src/a.ts', 'src/a.test.ts'],
  files: [{ path: 'src/a.test.ts', status: 'modified', additions: 3, deletions: 1 }], ...o,
});

describe('deltaApprovalEligibility', () => {
  test('a tests-only fix inside the PR is eligible', () => {
    expect(deltaApprovalEligibility(V(), 'H2', reading())).toMatchObject({ eligible: true, fromHeadSha: 'H1', files: 1, lines: 4 });
  });
  test('a new test file, or a test runner config, is eligible even though the PR did not have it', () => {
    expect(deltaApprovalEligibility(V(), 'H2', reading({ files: [{ path: 'src/__tests__/b.test.ts', status: 'added', additions: 20, deletions: 0 }] })).eligible).toBe(true);
    expect(deltaApprovalEligibility(V(), 'H2', reading({ files: [{ path: 'apps/web/vitest.config.ts', status: 'modified', additions: 1, deletions: 1 }] })).eligible).toBe(true);
  });
  test('a new non-test file outside the PR is a full review', () => {
    expect(deltaApprovalEligibility(V(), 'H2', reading({ files: [{ path: 'src/b.ts', status: 'added', additions: 2, deletions: 0 }] }))).toMatchObject({ eligible: false, reason: 'the delta touches a file outside the PR (src/b.ts)' });
  });
  test('deleting a test the PR did not touch is a full review', () => {
    expect(deltaApprovalEligibility(V(), 'H2', reading({ files: [{ path: 'src/c.test.ts', status: 'removed', additions: 0, deletions: 30 }] })).eligible).toBe(false);
  });
  test('a rename out of the PR counts both names', () => {
    expect(deltaApprovalEligibility(V(), 'H2', reading({ files: [{ path: 'src/elsewhere.ts', previousPath: 'src/a.ts', status: 'renamed', additions: 0, deletions: 0 }] })).eligible).toBe(false);
  });
  test('package manifests, lockfiles, CI and TypeScript or Bun config are not what the exemption covers', () => {
    for (const p of ['package.json', 'bun.lock', '.github/workflows/build.yml', 'packages/core/drizzle/x/migration.sql', 'tsconfig.json', 'apps/web/tsconfig.build.json', 'bunfig.toml']) {
      expect(isTestOrConfigPath(p)).toBe(false);
    }
  });
  test('production code under a test/spec/fixtures directory, or named after a test tool, is not a test', () => {
    for (const p of [
      'apps/web/src/app/api/test/route.ts',
      'apps/web/src/app/api/spec/route.ts',
      'apps/web/src/app/api/tests/route.ts',
      'apps/runner/src/playwright-pin.ts',
      'apps/web/src/app/app/dev/fixtures/page.tsx',
      'apps/web/src/lib/fixtures/seed.ts',
      'apps/web/src/lib/test-helpers.ts',
      'src/vitest.config.helpers.ts',
    ]) expect(isTestOrConfigPath(p)).toBe(false);
  });
  test('tests by file name, __tests__ anywhere, top-level test roots and exact test-runner configs are tests', () => {
    for (const p of [
      'src/a.test.ts', 'apps/web/src/lib/x.spec.tsx', 'pkg/foo_test.go', 'tools/test_parse.py',
      'apps/runner/__tests__/unit/x.ts', 'tests/e2e/flow.ts', 'test/helpers.ts', 'apps/web/tests/db/harness.ts', 'packages/core/test/x.ts',
      'vitest.config.ts', 'apps/web/playwright.config.ts', 'jest.config.cjs',
    ]) expect(isTestOrConfigPath(p)).toBe(true);
  });
  test('over the size cap is a full review', () => {
    const many = Array.from({ length: DELTA_MAX_FILES + 1 }, (_, i) => ({ path: 'src/a.ts', status: 'modified', additions: i === 0 ? 1 : 0, deletions: 0 }));
    expect(deltaApprovalEligibility(V(), 'H2', reading({ files: many })).eligible).toBe(false);
    expect(deltaApprovalEligibility(V(), 'H2', reading({ files: [{ path: 'src/a.ts', status: 'modified', additions: DELTA_MAX_LINES, deletions: 1 }] })).eligible).toBe(false);
    expect(deltaApprovalEligibility(V(), 'H2', reading({ files: [{ path: 'src/a.ts', status: 'modified', additions: Number.NaN, deletions: 0 }] })).eligible).toBe(false);
  });
  test('an unread delta, or a read for another head or from an unapproved one, is a full review', () => {
    expect(deltaApprovalEligibility(V(), 'H2', null)).toMatchObject({ eligible: false, reason: 'the delta could not be read' });
    expect(deltaApprovalEligibility(V(), 'H3', reading()).eligible).toBe(false);
    expect(deltaApprovalEligibility(V(), 'H2', reading({ fromHeadSha: 'H0' })).eligible).toBe(false);
  });
  test('an open finding (a requested change still open) is a full review', () => {
    const f: FindingSnapshot = { id: 'f1', originRoundId: 'r0', originRound: 0, originHeadSha: 'H0', ordinal: 1, path: 'src/a.ts', line: 1, title: 't', required: true, status: 'open' } as FindingSnapshot;
    expect(deltaApprovalEligibility(V({ findings: [f] }), 'H2', reading())).toMatchObject({ eligible: false, reason: 'a requested change is still open' });
  });
  test('only a reviewer verdict carries: a person\'s, a policy\'s or a composition\'s approval does not', () => {
    for (const basis of ['human', 'policy', 'composition'] as const) {
      expect(deltaApprovalEligibility(V({ d: { approvalBasis: basis } }), 'H2', reading()).eligible).toBe(false);
    }
  });
  test('the last decided round must have approved', () => {
    const rc = approved({ verdict: 'request_changes', effectiveVerdict: 'request_changes' });
    expect(deltaApprovalEligibility(V({ rounds: [rc] }), 'H2', reading()).eligible).toBe(false);
    expect(deltaApprovalEligibility(V({ rounds: [] }), 'H2', reading()).eligible).toBe(false);
  });
  test('a chain of carried deltas is measured from the last full review, not one step at a time', () => {
    // Round 1 approved H1 in full; round 2 carried it to H2 as a delta (measured from H1).
    const carried = approved({ id: 'r2', round: 2, headSha: 'H2', kind: 'delta', scope: { deltaApproval: { eligible: true, fromHeadSha: 'H1' } } });
    const v = V({ d: { approvedHeads: ['H2'], currentHeadSha: 'H2' }, rounds: [approved(), carried] });
    const step = (lines: number, from = 'H1') => reading({ fromHeadSha: from, toHeadSha: 'H3', files: [{ path: 'src/a.ts', status: 'modified', additions: lines, deletions: 0 }] });
    // The read must start at H1, the full review's head, not at H2.
    expect(deltaApprovalEligibility(v, 'H3', step(5, 'H2'))).toMatchObject({ eligible: false, reason: "the delta does not start at the last full review's approved head" });
    // H1..H3 together is small: eligible, still measured from H1.
    expect(deltaApprovalEligibility(v, 'H3', step(150))).toMatchObject({ eligible: true, fromHeadSha: 'H1' });
    // H1..H3 together is over the cap, however small H2..H3 alone is.
    expect(deltaApprovalEligibility(v, 'H3', step(DELTA_MAX_LINES + 1)).eligible).toBe(false);
  });
  test('the source of a delta read is the full review\'s head, or the newest approved head after a full approval', () => {
    expect(deltaApprovalSource(V({ d: { approvedHeads: ['H1', 'H1b'] } }))).toBe('H1b');
    const carried = approved({ id: 'r2', round: 2, headSha: 'H2', kind: 'delta', scope: { deltaApproval: { eligible: true, fromHeadSha: 'H1' } } });
    expect(deltaApprovalSource(V({ d: { approvedHeads: ['H2'] }, rounds: [approved(), carried] }))).toBe('H1');
    expect(deltaApprovalSource(V({ d: { approvalBasis: 'human' } }))).toBeNull();
  });
});
