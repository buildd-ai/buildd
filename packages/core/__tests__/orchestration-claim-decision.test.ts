import { describe, it, expect } from 'bun:test';
import { choice, defineDecision } from '@builddai/ai-kit/decide';
import {
  CLAIM_HOLD_APPLYING_FRACTION,
  CLAIM_HOLD_DECISION,
  CLAIM_HOLD_MIN_CONFIDENCE,
  CLAIM_HOLD_PROMPT_VERSION,
  buildClaimHoldState,
  deriveHolderStage,
  summarizeFileConflictHistory,
  claimHoldCandidatePolicyVersion,
  claimHoldStateDigest,
  classifyClaimHoldEligibility,
  isGatedStartReachable,
  isMigrationPath,
  type ClaimHoldCandidate,
  type ClaimHoldEligibilityInput,
} from '../orchestration-claim-decision';

/**
 * Hold/start at claim (§5b), pure half: the deterministic rails that decide
 * whether a deferral may be asked about at all, and the gated-start switch.
 */

const base = (over: Partial<ClaimHoldEligibilityInput> = {}): ClaimHoldEligibilityInput => ({
  gate: 'open_pr_overlap',
  forced: false,
  leaseReadFailed: false,
  concretePaths: ['apps/web/src/a.ts'],
  overlapPaths: ['apps/web/src/a.ts'],
  overlapsLiveLease: false,
  serializedSurfaces: [],
  holder: { taskId: 't-h', prNumber: 7, workerStatus: 'completed', prLifecycle: 'ci_green' },
  ...over,
});

describe('classifyClaimHoldEligibility: deterministic rails', () => {
  it('an open PR whose worker ended, with a plain overlap, is eligible', () => {
    expect(classifyClaimHoldEligibility(base())).toEqual({ eligible: true });
  });

  it('a scope-undeclared deferral (advisory_manifest) is eligible', () => {
    expect(classifyClaimHoldEligibility(base({
      gate: 'advisory_manifest', concretePaths: [], overlapPaths: [],
      holder: { taskId: 't-peer', prNumber: null, workerStatus: null, prLifecycle: null },
    }))).toEqual({ eligible: true });
  });

  it('never asks about a forced claim', () => {
    expect(classifyClaimHoldEligibility(base({ forced: true }))).toEqual({ eligible: false, rail: 'forced' });
  });

  it('an unresolved lease read is unknown state, never asked', () => {
    expect(classifyClaimHoldEligibility(base({ leaseReadFailed: true }))).toEqual({ eligible: false, rail: 'state_unresolved' });
    expect(classifyClaimHoldEligibility(base({ gate: 'advisory_manifest', leaseReadFailed: true })).eligible).toBe(false);
  });

  it('an overlap with a live exclusive lease is never asked', () => {
    expect(classifyClaimHoldEligibility(base({ overlapsLiveLease: true }))).toEqual({ eligible: false, rail: 'live_lease' });
  });

  it('a serialized surface is never asked', () => {
    expect(classifyClaimHoldEligibility(base({ serializedSurfaces: ['schema'] }))).toEqual({ eligible: false, rail: 'serialized_surface' });
  });

  it('a migration path on either side is never asked, even with no workspace config', () => {
    expect(classifyClaimHoldEligibility(base({ concretePaths: ['packages/core/drizzle/0001_x.sql'] }))).toEqual({ eligible: false, rail: 'migration' });
    expect(classifyClaimHoldEligibility(base({ overlapPaths: ['db/migrations/0002.sql'] }))).toEqual({ eligible: false, rail: 'migration' });
  });

  it.each(['running', 'starting', 'idle', 'waiting_input'])('a PR whose worker is %s is a live holder, never asked', (status) => {
    expect(classifyClaimHoldEligibility(base({ holder: { taskId: 't', prNumber: 7, workerStatus: status, prLifecycle: 'pr_open' } })))
      .toEqual({ eligible: false, rail: 'live_holder' });
  });

  it('a PR holder with unknown status is treated as live', () => {
    expect(classifyClaimHoldEligibility(base({ holder: { taskId: 't', prNumber: 7, workerStatus: null, prLifecycle: null } })))
      .toEqual({ eligible: false, rail: 'live_holder' });
  });

  it('a PR overlap with no overlapping paths recorded is not asked', () => {
    expect(classifyClaimHoldEligibility(base({ overlapPaths: [] }))).toEqual({ eligible: false, rail: 'no_overlap_data' });
  });
});

describe('classifyClaimHoldEligibility: soft_overlap (prefix-only declared overlap)', () => {
  const soft = (over: Partial<ClaimHoldEligibilityInput> = {}) => base({
    gate: 'soft_overlap',
    concretePaths: ['scripts/'],
    overlapPaths: ['scripts', 'scripts/run-unit-tests.ts'],
    holder: { taskId: 't-h', prNumber: null, workerStatus: 'running', prLifecycle: null },
    ...over,
  });

  it('is eligible even while the holder is live: the overlap is only by directory', () => {
    expect(classifyClaimHoldEligibility(soft())).toEqual({ eligible: true });
  });

  it('a live lease, a serialized surface, a migration or unknown state still wins', () => {
    expect(classifyClaimHoldEligibility(soft({ overlapsLiveLease: true }))).toEqual({ eligible: false, rail: 'live_lease' });
    expect(classifyClaimHoldEligibility(soft({ serializedSurfaces: ['x'] }))).toEqual({ eligible: false, rail: 'serialized_surface' });
    expect(classifyClaimHoldEligibility(soft({ overlapPaths: ['packages/core/drizzle'] }))).toEqual({ eligible: false, rail: 'migration' });
    expect(classifyClaimHoldEligibility(soft({ leaseReadFailed: true }))).toEqual({ eligible: false, rail: 'state_unresolved' });
    expect(classifyClaimHoldEligibility(soft({ forced: true }))).toEqual({ eligible: false, rail: 'forced' });
  });

  it('with no overlapping paths there is nothing to ask about', () => {
    expect(classifyClaimHoldEligibility(soft({ overlapPaths: [] }))).toEqual({ eligible: false, rail: 'no_overlap_data' });
  });
});

describe('isMigrationPath', () => {
  it.each([
    ['packages/core/drizzle/0001_a.sql', true],
    ['packages/core/drizzle/meta/_journal.json', true],
    ['db/migrations/x.ts', true],
    ['prisma/migrations/1/migration.sql', true],
    ['scripts/seed.sql', true],
    ['apps/web/src/lib/migrate-helper.ts', false],
    ['apps/web/src/app/page.tsx', false],
  ])('%s → %s', (p, want) => {
    expect(isMigrationPath(p)).toBe(want);
  });
});

describe('gated START is live, with a single rollback switch', () => {
  it('ships gated at a conservative threshold with every eligible deferral in the applying arm', () => {
    expect(CLAIM_HOLD_DECISION.policyOf('action').mode).toBe('gated');
    expect(CLAIM_HOLD_DECISION.policyOf('action').minConfidence).toBe(CLAIM_HOLD_MIN_CONFIDENCE);
    expect(CLAIM_HOLD_MIN_CONFIDENCE).toBeGreaterThanOrEqual(0.8);
    expect(CLAIM_HOLD_APPLYING_FRACTION).toBe(1);
    expect(isGatedStartReachable()).toBe(true);
  });

  it('rolling back is a zero fraction: deterministic HOLD everywhere', () => {
    expect(isGatedStartReachable(CLAIM_HOLD_DECISION, 0)).toBe(false);
  });

  it('needs BOTH a non-shadow policy and a positive fraction', () => {
    const q = { action: choice({ question: 'q' }, { HOLD: 'h', START: 's' }) };
    const gated = defineDecision({ id: 'buildd.t_claim', promptVersion: 't', questions: q, mode: 'gated', minConfidence: 0.9 });
    const shadow = defineDecision({ id: 'buildd.t_claim', promptVersion: 't', questions: q, mode: 'shadow' });
    expect(isGatedStartReachable(gated, 0)).toBe(false);
    expect(isGatedStartReachable(shadow, 0.5)).toBe(false);
    expect(isGatedStartReachable(gated, 0.1)).toBe(true);
    expect(isGatedStartReachable(gated, Number.NaN)).toBe(false);
  });

  it('the definition is namespaced and fingerprinted', () => {
    expect(CLAIM_HOLD_DECISION.id).toBe('buildd.orchestration_claim_hold');
    expect(CLAIM_HOLD_DECISION.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(Object.keys(CLAIM_HOLD_DECISION.questions)).toEqual(['action']);
  });
});

const candidate = (over: Partial<ClaimHoldCandidate> = {}): ClaimHoldCandidate => ({
  gate: 'open_pr_overlap',
  teamId: 'team', workspaceId: 'ws', missionId: null, taskId: 'task',
  accountId: null,
  deferredAt: '2026-09-30T12:00:00.000Z',
  taskCreatedAt: '2026-09-30T11:00:00.000Z',
  scope: 'declared',
  concretePaths: ['a.ts', 'b.ts'],
  overlapPaths: ['a.ts'],
  retryKind: null,
  holder: { taskId: 'h', prNumber: 7, workerStatus: 'completed', prLifecycle: 'ci_green' },
  title: 'Add a thing',
  ...over,
});

describe('claim-time digest and state', () => {
  it('the digest is order-insensitive and changes with the holder state', () => {
    const a = claimHoldStateDigest(candidate());
    expect(claimHoldStateDigest(candidate({ concretePaths: ['b.ts', 'a.ts'] }))).toBe(a);
    expect(claimHoldStateDigest(candidate({ holder: { taskId: 'h', prNumber: 7, workerStatus: 'completed', prLifecycle: 'conflict' } }))).not.toBe(a);
    expect(claimHoldStateDigest(candidate({ overlapPaths: ['b.ts'] }))).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it('each gate has its own candidate policy version', () => {
    expect(claimHoldCandidatePolicyVersion('advisory_manifest')).toBe('ch1.advisory_manifest');
    expect(claimHoldCandidatePolicyVersion('open_pr_overlap')).toBe('ch1.open_pr_overlap');
  });

  it('the state carries the rule verdict, holder liveness, overlap and base freshness', () => {
    const s = buildClaimHoldState(candidate(), {
      title: 'Other', workerStatus: 'completed', lastActivityAt: '2026-09-30T11:30:00.000Z', prLifecycle: 'conflict', baseStale: true,
    }) as any;
    expect(s.rule).toEqual({ verdict: 'HOLD', reason: 'open_pr_overlap' });
    expect(s.holder.live).toBe(false);
    expect(s.holder.minutesSinceActivity).toBe(30);
    expect(s.holder.overlappingPaths).toEqual(['a.ts']);
    expect(s.candidate.waitingMinutes).toBe(60);
    expect(s.baseFreshness).toBe('holder_conflicts_with_base');
    expect(s.deterministicRails.laterGates).toBe('still_apply');
  });

  it('with no holder read the state still builds, and base freshness is unknown', () => {
    const s = buildClaimHoldState(candidate({ gate: 'advisory_manifest', scope: 'undeclared', concretePaths: [], overlapPaths: [] }), null) as any;
    expect(s.baseFreshness).toBe('unknown');
    expect(s.holder.live).toBe(true);
  });
});

describe('same-file soft overlap: the inputs Jev decides with', () => {
  const sameFile = (over: Partial<ClaimHoldCandidate> = {}): ClaimHoldCandidate => ({
    gate: 'soft_overlap',
    teamId: 'team', workspaceId: 'ws', missionId: null, taskId: 'cand', accountId: null,
    deferredAt: '2026-09-30T12:00:00.000Z', taskCreatedAt: '2026-09-30T11:00:00.000Z',
    scope: 'declared', concretePaths: ['apps/web/src/lib/x.ts'], overlapPaths: ['apps/web/src/lib/x.ts'],
    overlapKind: 'same_file', retryKind: null,
    holder: { taskId: 'h', prNumber: null, workerStatus: 'running', prLifecycle: null },
    title: 'Add a thing',
    ...over,
  });

  it('bumps the prompt version for the new inputs', () => {
    expect(CLAIM_HOLD_PROMPT_VERSION).toBe('ch4');
  });

  it('the digest distinguishes a same-file overlap from a prefix one on the same paths', () => {
    expect(claimHoldStateDigest(sameFile())).not.toBe(claimHoldStateDigest(sameFile({ overlapKind: 'prefix' })));
  });

  it('deriveHolderStage reads where the holder is: queued, just started, working, in review, approved', () => {
    const now = '2026-09-30T12:00:00.000Z';
    expect(deriveHolderStage({ workerStatus: null, startedAt: null, prNumber: null, prLifecycle: null, approved: false, now })).toBe('queued');
    expect(deriveHolderStage({ workerStatus: 'running', startedAt: '2026-09-30T11:55:00.000Z', prNumber: null, prLifecycle: null, approved: false, now })).toBe('just_started');
    expect(deriveHolderStage({ workerStatus: 'running', startedAt: '2026-09-30T10:00:00.000Z', prNumber: null, prLifecycle: null, approved: false, now })).toBe('working');
    expect(deriveHolderStage({ workerStatus: 'completed', startedAt: '2026-09-30T10:00:00.000Z', prNumber: 9, prLifecycle: 'ci_green', approved: false, now })).toBe('in_review');
    expect(deriveHolderStage({ workerStatus: 'completed', startedAt: '2026-09-30T10:00:00.000Z', prNumber: 9, prLifecycle: 'ci_green', approved: true, now })).toBe('approved');
  });

  it('summarizeFileConflictHistory: no merged PRs on a file reads as no_history, not as safe or unsafe', () => {
    const h = summarizeFileConflictHistory(['apps/web/src/lib/x.ts'], []);
    expect(h.summary).toBe('no_history');
    expect(h.files).toEqual([{ path: 'apps/web/src/lib/x.ts', mergedPrs: 0, conflicted: 0, rate: null, ci: null }]);
  });

  it('summarizeFileConflictHistory reports the per-file rate and the worst file', () => {
    const h = summarizeFileConflictHistory(['a.ts', 'b.ts'], [
      { path: 'a.ts', mergedPrs: 10, conflicted: 1 },
      { path: 'b.ts', mergedPrs: 4, conflicted: 2 },
    ]);
    expect(h.files.map(f => f.rate)).toEqual([0.1, 0.5]);
    expect(h.maxRate).toBe(0.5);
    // 2 of 4 is a point rate of 0.5 on too small a sample to call.
    expect(h.summary).toBe('insufficient');
    expect(summarizeFileConflictHistory(['a.ts'], [{ path: 'a.ts', mergedPrs: 10, conflicted: 7 }]).summary).toBe('high');
    expect(summarizeFileConflictHistory(['a.ts'], [{ path: 'a.ts', mergedPrs: 20, conflicted: 1 }]).summary).toBe('insufficient');
    expect(summarizeFileConflictHistory(['a.ts'], [{ path: 'a.ts', mergedPrs: 40, conflicted: 1 }]).summary).toBe('low');
  });

  it('the state names the overlap kind, holder stage, conflict history and predicted change size', () => {
    const s = buildClaimHoldState(sameFile(), {
      title: 'Other', workerStatus: 'running', lastActivityAt: '2026-09-30T11:59:00.000Z', prLifecycle: null, baseStale: null, stage: 'just_started',
    }, {
      conflictHistory: summarizeFileConflictHistory(['apps/web/src/lib/x.ts'], []),
      predictedChange: { files: 3, minutes: 20, source: 'neighbours' },
    }) as any;
    expect(s.overlap.kind).toBe('same_file');
    expect(s.holder.kind).toBe('in_flight_task_editing_the_same_file');
    expect(s.holder.stage).toBe('just_started');
    expect(s.conflictHistory.summary).toBe('no_history');
    expect(s.candidate.predictedChange).toEqual({ files: 3, minutes: 20, source: 'neighbours' });
  });

  it('without evidence the state says unknown rather than inventing a figure', () => {
    const s = buildClaimHoldState(sameFile(), null) as any;
    expect(s.conflictHistory).toEqual({ summary: 'unknown' });
    expect(s.candidate.predictedChange).toEqual({ source: 'declared_paths', files: 1 });
    expect(s.holder.stage).toBe('unknown');
    expect(s.risk).toEqual({ tier: 'unknown' });
  });

  it('the state carries the risk tier code computed, as tier and short reasons only', () => {
    const risk = { tier: 'uncertain' as const, route: 'ask_model' as const, reasons: ['same_file' as const, 'history_missing' as const], rationale: 'prose the model must not see', evidence: { source: 'declared_overlap' as const, ageMinutes: null }, reevaluateOn: [] };
    const s = buildClaimHoldState(sameFile({ risk }), null) as any;
    expect(s.risk).toEqual({ tier: 'uncertain', reasons: ['same_file', 'history_missing'] });
    expect(JSON.stringify(s)).not.toContain('prose the model must not see');
  });
});
