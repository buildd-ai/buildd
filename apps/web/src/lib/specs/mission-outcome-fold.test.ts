import { describe, it, expect } from 'bun:test';
import { foldMissionSpec, verdictIsCurrent, type MissionTarget, type MissionVerdictRow } from './mission-outcome-fold';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const integration = (headSha = A): MissionTarget => ({ kind: 'integration', headSha, branch: 'mission/x' });
let n = 0;
const row = (criterionId: string, verdict: MissionVerdictRow['verdict'], headSha: string | null = A, at = `2026-10-14T10:${String(10 + (n++ % 50)).padStart(2, '0')}:00Z`): MissionVerdictRow =>
  ({ id: `v${n}`, criterionId, verdict, headSha, at, source: 'test' });

describe('foldMissionSpec', () => {
  it('passes only when every in-scope criterion passes on the current integration head', () => {
    const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows: [row('R-1', 'pass'), row('R-2', 'pass')], target: integration() });
    expect(r.verdict).toBe('pass');
    expect(r.evidence).toContain('two tested checks pass on aaaaaaa');
  });

  // AC-38 / AC-13: PR reviews can all pass and the mission still waits on the integrated audit.
  for (const v of ['inconclusive', 'unsupported'] as const) {
    it(`does not pass when one criterion is ${v}`, () => {
      const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows: [row('R-1', 'pass'), row('R-2', v)], target: integration() });
      expect(r.verdict).toBe('UNVERIFIED');
      expect(r.standings.find((s) => s.criterionId === 'R-2')?.standing).toBe(v);
    });
  }

  it('does not pass when a criterion has no verdict', () => {
    const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows: [row('R-1', 'pass')], target: integration() });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.evidence).toContain('R-2 has no verdict');
  });

  it('fails when any criterion failed', () => {
    const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows: [row('R-1', 'pass'), row('R-2', 'fail')], target: integration() });
    expect(r.verdict).toBe('fail');
  });

  it('reads a pass on an older integration head as stale after a new commit lands', () => {
    const rows = [row('R-1', 'pass', A), row('R-2', 'pass', A)];
    expect(foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows, target: integration(A) }).verdict).toBe('pass');
    const moved = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows, target: integration(B) });
    expect(moved.verdict).toBe('UNVERIFIED');
    expect(moved.standings.every((s) => s.standing === 'stale')).toBe(true);
  });

  // c5a2c67b R-4 / AC-2: a fail judged a commit the target has moved past is re-checked, not kept.
  it('reads a fail on an older integration head as stale once the target moves, so it is checked again', () => {
    const rows = [row('R-1', 'pass', A), row('R-2', 'fail', A)];
    expect(foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows, target: integration(A) }).verdict).toBe('fail');
    const moved = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows, target: integration(B) });
    expect(moved.verdict).toBe('UNVERIFIED');
    expect(moved.standings.find((s) => s.criterionId === 'R-2')?.standing).toBe('stale');
    expect(moved.evidence).toContain('R-2 failed on an older commit');
    expect(moved.evidence).toContain('R-1 passed on an older commit');
  });

  it('direct missions: a fail at a commit missing a newer merged mission PR reads stale', () => {
    const target: MissionTarget = { kind: 'direct', mergeShas: ['c'.repeat(40)], validHeads: new Set([B]) };
    const r = foldMissionSpec({ scope: ['R-1'], waived: [], rows: [row('R-1', 'fail', A)], target });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.standings[0].standing).toBe('stale');
    const still = foldMissionSpec({ scope: ['R-1'], waived: [], rows: [row('R-1', 'fail', B)], target });
    expect(still.verdict).toBe('fail');
  });

  it('a fail with no target to compare against still fails', () => {
    const r = foldMissionSpec({ scope: ['R-1'], waived: [], rows: [row('R-1', 'fail', A)], target: { kind: 'unknown', reason: 'the integration branch could not be read' } });
    expect(r.verdict).toBe('fail');
  });

  it('the newest verdict stands: a re-check that passes clears an earlier fail', () => {
    const r = foldMissionSpec({ scope: ['R-1'], waived: [], rows: [row('R-1', 'fail', A, '2026-10-14T09:00:00Z'), row('R-1', 'pass', B, '2026-10-14T11:00:00Z')], target: integration(B) });
    expect(r.verdict).toBe('pass');
  });

  it('leaves a waived criterion out of the fold and shows it as waived, never as passed', () => {
    const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: ['R-2'], rows: [row('R-1', 'pass')], target: integration() });
    expect(r.verdict).toBe('pass');
    expect(r.standings.find((s) => s.criterionId === 'R-2')?.standing).toBe('waived');
    expect(r.evidence).toContain('one waived by a person');
  });

  it('does not pass when every criterion is waived', () => {
    expect(foldMissionSpec({ scope: ['R-1'], waived: ['R-1'], rows: [], target: integration() }).verdict).toBe('UNVERIFIED');
  });

  it('is never a pass without a known target', () => {
    const r = foldMissionSpec({ scope: ['R-1'], waived: [], rows: [row('R-1', 'pass')], target: { kind: 'unknown', reason: 'the integration branch could not be read' } });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.evidence).toContain('could not be read');
  });

  it('direct missions: a verdict holds only at a commit that contains every merged mission PR', () => {
    const target: MissionTarget = { kind: 'direct', mergeShas: ['c'.repeat(40)], validHeads: new Set([B]) };
    expect(verdictIsCurrent(target, B)).toBe(true);
    expect(verdictIsCurrent(target, A)).toBe(false);
    const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows: [row('R-1', 'pass', B), row('R-2', 'pass', A)], target });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.standings.find((s) => s.criterionId === 'R-2')?.standing).toBe('stale');
  });
});

describe('foldMissionSpec: a test result outranks a reviewer opinion', () => {
  it('a later review pass cannot override a failed test', () => {
    const rows = [{ ...row('R-1', 'fail', A, '2026-10-14T10:00:00Z'), source: 'test' as const }, { ...row('R-1', 'pass', A, '2026-10-14T11:00:00Z'), source: 'review' as const }];
    expect(foldMissionSpec({ scope: ['R-1'], waived: [], rows, target: integration() }).verdict).toBe('fail');
  });

  it('a later test supersedes the failed one', () => {
    const rows = [{ ...row('R-1', 'fail', A, '2026-10-14T10:00:00Z'), source: 'test' as const }, { ...row('R-1', 'pass', A, '2026-10-14T11:00:00Z'), source: 'test' as const }];
    expect(foldMissionSpec({ scope: ['R-1'], waived: [], rows, target: integration() }).verdict).toBe('pass');
  });
});


describe('R-83: achievement counts tested checks only', () => {
  for (const verdict of ['pass', 'fail', 'inconclusive', 'unsupported'] as const) {
    it(`keeps a judged ${verdict} beside passing tests without counting it`, () => {
      const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], target: integration(), rows: [
        row('R-1', 'pass'), { ...row('R-2', verdict), source: 'review' },
      ] });
      expect(r.verdict).toBe('pass');
      expect(r.evidence).toContain('The tested check passes');
      expect(r.standings[1]).toMatchObject({ criterionId: 'R-2', standing: verdict, source: 'review' });
    });
  }

  it('does not award achievement from reviewer passes alone, including legacy rows', () => {
    const judged = { ...row('R-1', 'pass'), source: undefined };
    expect(foldMissionSpec({ scope: ['R-1'], waived: [], rows: [judged], target: integration() }).verdict).toBe('UNVERIFIED');
  });

  it('keeps an inconclusive test open even when a later reviewer passes it', () => {
    const r = foldMissionSpec({ scope: ['R-1'], waived: [], target: integration(), rows: [
      row('R-1', 'inconclusive', A, '2026-10-14T10:00:00Z'),
      { ...row('R-1', 'pass', A, '2026-10-14T11:00:00Z'), source: 'review' },
    ] });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.standings[0]).toMatchObject({ standing: 'inconclusive', source: 'test' });
  });

  it('does not count a review toward the passing-test total', () => {
    const r = foldMissionSpec({ scope: ['R-1', 'R-2', 'R-3'], waived: [], target: integration(), rows: [
      row('R-1', 'pass'), row('R-2', 'inconclusive'), { ...row('R-3', 'pass'), source: 'review' },
    ] });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.evidence).toContain('One of two');
  });

  it('requires tests on the merged result even with current reviewer passes', () => {
    const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], target: integration(B), rows: [
      row('R-1', 'pass', A), { ...row('R-2', 'pass', B), source: 'review' },
    ] });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.standings[0].standing).toBe('stale');
  });
});

describe('R-80: unaccepted acceptance test edits drop test results', () => {
  it('drops acceptance test verdicts when there are unaccepted test edits', () => {
    const acceptanceTestRow = {
      ...row('R-1', 'pass', A),
      source: 'test' as const,
      evidence: { kind: 'acceptance-test', testName: 'basic.test.ts' },
    };
    const r = foldMissionSpec({
      scope: ['R-1'],
      waived: [],
      rows: [acceptanceTestRow],
      target: integration(),
      unacceptedTestPaths: ['apps/web/src/__tests__/basic.test.ts'],
    });
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.standings[0].standing).toBe('missing');
    expect(r.evidence).toContain('No tested checks');
  });

  it('keeps acceptance test verdicts when all edits are accepted', () => {
    const acceptanceTestRow = {
      ...row('R-1', 'pass', A),
      source: 'test' as const,
      evidence: { kind: 'acceptance-test', testName: 'basic.test.ts' },
    };
    const r = foldMissionSpec({
      scope: ['R-1'],
      waived: [],
      rows: [acceptanceTestRow],
      target: integration(),
      unacceptedTestPaths: [], // No unaccepted paths
    });
    expect(r.verdict).toBe('pass');
    expect(r.standings[0].standing).toBe('pass');
  });

  it('drops acceptance test results but keeps other test results when there are unaccepted edits', () => {
    const acceptanceTestRow = {
      ...row('R-1', 'pass', A),
      source: 'test' as const,
      evidence: { kind: 'acceptance-test', testName: 'basic.test.ts' },
    };
    const otherTestRow = {
      ...row('R-2', 'pass', A),
      source: 'test' as const,
      evidence: { kind: 'some-other-check' },
    };
    const r = foldMissionSpec({
      scope: ['R-1', 'R-2'],
      waived: [],
      rows: [acceptanceTestRow, otherTestRow],
      target: integration(),
      unacceptedTestPaths: ['apps/web/src/__tests__/basic.test.ts'],
    });
    // R-1's acceptance test is dropped, so it's missing. R-2's other test is kept.
    expect(r.verdict).toBe('UNVERIFIED');
    expect(r.standings[0].standing).toBe('missing');
    expect(r.standings[1].standing).toBe('pass');
    expect(r.evidence).toContain('One of two');
  });
});
