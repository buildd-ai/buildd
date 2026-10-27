import { describe, expect, it } from 'bun:test';
import { foldMissionSpec, type MissionVerdictRow } from './mission-outcome-fold';

const HEAD = 'a'.repeat(40);
const OLD = 'b'.repeat(40);
const CLARITY = 'clarity-binding-v1';
const ACTIONS = 'actions-binding-v1';
type RegisteredRow = MissionVerdictRow & { bindingFingerprint?: string | null };
const row = (id: string, verdict: MissionVerdictRow['verdict'], extra: Partial<RegisteredRow> = {}): RegisteredRow => ({
  id, criterionId: 'R-2', verdict, headSha: HEAD, at: '2026-10-21T12:00:00Z', source: 'review', bindingFingerprint: CLARITY, ...extra,
});
function fold(rows: RegisteredRow[], expected: readonly string[] = [CLARITY]) {
  const input = { scope: ['R-1', 'R-2'], waived: [], target: { kind: 'integration' as const, headSha: HEAD, branch: 'mission/x' },
    rows: [row('test', 'pass', { criterionId: 'R-1', source: 'test', bindingFingerprint: null }), ...rows],
    requiredBindings: new Map([['R-2', expected]]),
  };
  return foldMissionSpec(input as Parameters<typeof foldMissionSpec>[0] & { requiredBindings: ReadonlyMap<string, readonly string[]> });
}

describe('registered mission checks participate in Verify before Deliver', () => {
  it('AC-2: a required model verifier failure blocks even though it remains a review source', () => {
    const result = fold([row('model-fail', 'fail')]);
    expect(result.verdict).toBe('fail');
    expect(result.standings.find(s => s.criterionId === 'R-2')).toMatchObject({ standing: 'fail', source: 'review' });
  });

  it.each(['inconclusive', 'unsupported'] as const)('AC-2: a required %s cannot be excluded beside a passing command test', verdict => {
    expect(fold([row('model-open', verdict)]).verdict).toBe('UNVERIFIED');
  });

  it('AC-2: a matching current registered pass counts without pretending the model is a deterministic test', () => {
    const result = fold([row('model-pass', 'pass')]);
    expect(result.verdict).toBe('pass');
    expect(result.standings.find(s => s.criterionId === 'R-2')).toMatchObject({ standing: 'pass', source: 'review' });
  });

  it('AC-4: an old binding version or an unbound human review cannot satisfy the required binding', () => {
    expect(fold([row('old-version', 'pass', { bindingFingerprint: 'old-binding' })]).verdict).toBe('UNVERIFIED');
    expect(fold([row('unbound', 'pass', { bindingFingerprint: null })]).verdict).toBe('UNVERIFIED');
  });

  it('AC-4: evidence on an older integrated target cannot satisfy the current target', () => {
    expect(fold([row('stale', 'pass', { headSha: OLD })]).verdict).toBe('UNVERIFIED');
  });

  it('AC-4: every required binding needs its own matching result; one pass cannot hide another failure', () => {
    expect(fold([row('clarity-pass', 'pass')], [CLARITY, ACTIONS]).verdict).toBe('UNVERIFIED');
    expect(fold([row('clarity-pass', 'pass'), row('action-fail', 'fail', { bindingFingerprint: ACTIONS })], [CLARITY, ACTIONS]).verdict).toBe('fail');
    expect(fold([row('clarity-pass', 'pass'), row('action-pass', 'pass', { bindingFingerprint: ACTIONS })], [CLARITY, ACTIONS]).verdict).toBe('pass');
  });

  it('AC-4: a later review cannot override a current deterministic test failure', () => {
    const result = fold([row('command-fail', 'fail', { source: 'test', bindingFingerprint: null }),
      row('model-pass', 'pass', { at: '2026-10-21T13:00:00Z' })]);
    expect(result.verdict).toBe('fail');
  });

  it('a passing command for the same criterion cannot hide a required model failure', () => {
    expect(fold([row('command-pass', 'pass', { source: 'test', bindingFingerprint: null }), row('model-fail', 'fail')]).verdict).toBe('fail');
  });

  it('a later deterministic registered pass cannot override a separate command failure', () => {
    expect(fold([row('command-fail', 'fail', { source: 'test', bindingFingerprint: null }),
      row('registered-pass', 'pass', { source: 'test', at: '2026-10-21T13:00:00Z' })]).verdict).toBe('fail');
  });

  it('required registered checks can verify a mission without relabeling them as tests', () => {
    const result = foldMissionSpec({ scope: ['R-2'], waived: [], rows: [row('model-pass', 'pass')],
      target: { kind: 'integration', headSha: HEAD, branch: 'mission/x' },
      requiredBindings: new Map([['R-2', [CLARITY]]]),
    } as Parameters<typeof foldMissionSpec>[0] & { requiredBindings: ReadonlyMap<string, readonly string[]> });
    expect(result.verdict).toBe('pass');
    expect(result.standings[0].source).toBe('review');
  });

  it('does not treat a registered failure as current while the integrated target is unknown', () => {
    expect(foldMissionSpec({ scope: ['R-2'], waived: [], rows: [row('model-fail', 'fail')],
      target: { kind: 'unknown', reason: 'target unavailable' }, requiredBindings: new Map([['R-2', [CLARITY]]]),
    }).verdict).toBe('UNVERIFIED');
  });

  it('preserves legacy achievement behavior when the criterion has no required registered binding', () => {
    expect(fold([row('legacy-review', 'fail', { bindingFingerprint: null })], []).verdict).toBe('pass');
  });

  it('advisory deterministic results cannot replace a separate legacy command result', () => {
    expect(fold([row('command-pass', 'pass', { source: 'test', bindingFingerprint: null }),
      row('advisory-fail', 'fail', { source: 'test', at: '2026-10-21T13:00:00Z' })], []).verdict).toBe('pass');
  });
});
