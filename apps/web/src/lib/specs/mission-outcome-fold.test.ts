import { describe, it, expect } from 'bun:test';
import { foldMissionSpec, verdictIsCurrent, type MissionTarget, type MissionVerdictRow } from './mission-outcome-fold';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const integration = (headSha = A): MissionTarget => ({ kind: 'integration', headSha, branch: 'mission/x' });
let n = 0;
const row = (criterionId: string, verdict: MissionVerdictRow['verdict'], headSha: string | null = A, at = `2026-10-14T10:${String(10 + (n++ % 50)).padStart(2, '0')}:00Z`): MissionVerdictRow =>
  ({ id: `v${n}`, criterionId, verdict, headSha, at });

describe('foldMissionSpec', () => {
  it('passes only when every in-scope criterion passes on the current integration head', () => {
    const r = foldMissionSpec({ scope: ['R-1', 'R-2'], waived: [], rows: [row('R-1', 'pass'), row('R-2', 'pass')], target: integration() });
    expect(r.verdict).toBe('pass');
    expect(r.evidence).toContain('two criteria pass on aaaaaaa');
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
