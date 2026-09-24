import { describe, it, expect } from 'bun:test';
import {
  planRepair,
  needsRunLookup,
  SKIPPED_REASON,
  FALSE_NEVER_MERGED_SUFFIX,
  type RepairRow,
} from './repair-release-rows';

const row = (over: Partial<RepairRow> = {}): RepairRow => ({
  id: 'rel-1',
  archetype: 'gated',
  failureReason: SKIPPED_REASON,
  headSha: 'sha',
  runUrl: null,
  workflowFile: 'release.yml',
  repoFullName: 'org/repo',
  ...over,
});
const RUN = 'https://github.com/org/repo/actions/runs/1';
const NOW = new Date('2026-01-01T00:00:00Z');

describe('planRepair — rows failed as "workflow conclusion: skipped"', () => {
  it('needs the real run looked up', () => {
    expect(needsRunLookup(row())).toBe(true);
    expect(needsRunLookup(row({ failureReason: `x — ${FALSE_NEVER_MERGED_SUFFIX}` }))).toBe(false);
  });

  it('a gated row whose real release run succeeded goes back to pending_external', () => {
    expect(planRepair(row(), { conclusion: 'success', htmlUrl: RUN }, NOW)).toMatchObject({
      kind: 'update',
      set: { state: 'pending_external', failureReason: null, runUrl: RUN },
    });
  });

  it('a continuous row whose real release run succeeded re-enters verification', () => {
    expect(planRepair(row({ archetype: 'continuous' }), { conclusion: 'success', htmlUrl: RUN }, NOW)).toMatchObject({
      kind: 'update',
      set: { state: 'deploying', deployedAt: NOW, failureReason: null, runUrl: RUN },
    });
  });

  it('a real failure stays failed but records the real conclusion', () => {
    const plan = planRepair(row(), { conclusion: 'failure', htmlUrl: RUN }, NOW);
    expect(plan).toMatchObject({ kind: 'update', set: { failureReason: 'workflow conclusion: failure', runUrl: RUN } });
    expect((plan as any).set.state).toBeUndefined();
  });

  it.each([
    ['release run itself skipped', { conclusion: 'skipped', htmlUrl: RUN }],
    ['run still in progress', { conclusion: null, htmlUrl: RUN }],
    ['no run found', null],
    ['lookup failed', 'unknown'],
  ])('leaves the row alone when: %s', (_label, realRun) => {
    expect(planRepair(row(), realRun as any, NOW).kind).toBe('skip');
  });
});

describe('planRepair — rows failed as "the release PR was never merged"', () => {
  const reason = `never advanced past 'pending_external' within 24h — ${FALSE_NEVER_MERGED_SUFFIX}`;

  it('re-arms a gated row for the cron to re-check', () => {
    expect(planRepair(row({ failureReason: reason }), null, NOW)).toMatchObject({
      kind: 'update',
      set: { state: 'pending_external', failureReason: null },
    });
  });

  it('skips a row with no sha, or a non-gated row', () => {
    expect(planRepair(row({ failureReason: reason, headSha: null }), null, NOW).kind).toBe('skip');
    expect(planRepair(row({ failureReason: reason, archetype: 'continuous' }), null, NOW).kind).toBe('skip');
  });
});

it('ignores any other failure reason', () => {
  expect(planRepair(row({ failureReason: 'dispatch failed: 422' }), null, NOW).kind).toBe('skip');
});
