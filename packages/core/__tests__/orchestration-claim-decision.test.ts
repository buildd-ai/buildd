import { describe, it, expect } from 'bun:test';
import { choice, defineDecision } from '@builddai/ai-kit/decide';
import {
  CLAIM_HOLD_APPLYING_FRACTION,
  CLAIM_HOLD_DECISION,
  buildClaimHoldState,
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

describe('gated START is unreachable by default', () => {
  it('ships in shadow with a zero applying fraction', () => {
    expect(CLAIM_HOLD_DECISION.policyOf('action').mode).toBe('shadow');
    expect(CLAIM_HOLD_APPLYING_FRACTION).toBe(0);
    expect(isGatedStartReachable()).toBe(false);
  });

  it('needs BOTH a non-shadow policy and a positive fraction', () => {
    const q = { action: choice({ question: 'q' }, { HOLD: 'h', START: 's' }) };
    const gated = defineDecision({ id: 'buildd.t_claim', promptVersion: 't', questions: q, mode: 'gated', minConfidence: 0.9 });
    expect(isGatedStartReachable(gated, 0)).toBe(false);
    expect(isGatedStartReachable(CLAIM_HOLD_DECISION, 0.5)).toBe(false);
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
