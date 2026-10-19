import { describe, it, expect } from 'bun:test';
import { determiningVerdict, verdictSourceOfEvidence } from '@buildd/spec-contract/outcome';
import { acceptanceTestRecord, acceptanceTestVerdict, parseAcceptanceTestRun } from './acceptance-test-result';
import { foldMissionSpec, type MissionTarget } from './mission-outcome-fold';

const SHA = 'a'.repeat(40);
const target: MissionTarget = { kind: 'integration', headSha: SHA, branch: 'mission/x' };

/** The row `recordMissionSpecVerdict` writes for a run: the same record builder, folded by the real selection logic. */
const rowFor = (criterionId: string, body: unknown, at: string) => {
  const run = parseAcceptanceTestRun(body)!;
  const rec = acceptanceTestRecord(criterionId, run);
  return { id: `${criterionId}-${at}`, criterionId, verdict: rec.verdict, headSha: SHA, at, evidence: { ...rec.evidence, recordedBy: rec.recordedBy } };
};

describe('an acceptance test exit code is its check result (AC-127)', () => {
  it('maps 0 to pass, any other code to fail, a run that could not start to inconclusive', () => {
    expect(acceptanceTestVerdict({ exitCode: 0 })).toBe('pass');
    expect(acceptanceTestVerdict({ exitCode: 1 })).toBe('fail');
    expect(acceptanceTestVerdict({ exitCode: 127 })).toBe('fail');
    expect(acceptanceTestVerdict({ exitCode: null, started: false })).toBe('inconclusive');
    expect(acceptanceTestVerdict({ exitCode: 1, started: false })).toBe('inconclusive');
    expect(acceptanceTestVerdict({ exitCode: null })).toBe('inconclusive');
  });

  it('rejects a body that is not a run, and ignores a claimed verdict', () => {
    expect(parseAcceptanceTestRun('x')).toBeNull();
    expect(parseAcceptanceTestRun({ exitCode: 'zero' })?.exitCode).toBeNull();
    expect(acceptanceTestRecord('AC-3', parseAcceptanceTestRun({ exitCode: 1, verdict: 'pass' })!).verdict).toBe('fail');
  });

  it('authors the record as a test with the exit code and a bounded output tail', () => {
    const rec = acceptanceTestRecord('AC-3', parseAcceptanceTestRun({ exitCode: 1, testName: 't', stdout: 'x'.repeat(5000) })!);
    expect(rec.recordedBy).toBe('check:acceptance:AC-3');
    expect(verdictSourceOfEvidence({ recordedBy: rec.recordedBy })).toBe('test');
    expect(rec.evidence).toMatchObject({ kind: 'acceptance-test', exitCode: 1, testName: 't' });
    expect((rec.evidence.stdout as string).length).toBe(2000);
  });

  it('a failing exit code leaves the check at fail even after a later reviewer pass, through the real selection and fold', () => {
    const fail = rowFor('AC-3', { exitCode: 1 }, '2026-10-19T10:00:00Z');
    const review = { id: 'r', criterionId: 'AC-3', verdict: 'pass' as const, headSha: SHA, at: '2026-10-19T11:00:00Z', evidence: { recordedBy: 'user:someone' } };
    const picked = determiningVerdict([fail, review].map((r) => ({ ...r, source: verdictSourceOfEvidence(r.evidence) })));
    expect(picked?.verdict).toBe('fail');
    const folded = foldMissionSpec({ scope: ['AC-3'], waived: [], rows: [fail, review].map((r) => ({ ...r, source: verdictSourceOfEvidence(r.evidence) })), target });
    expect(folded.verdict).toBe('fail');
    expect(foldMissionSpec({ scope: ['AC-3'], waived: [], rows: [rowFor('AC-3', { exitCode: 0 }, '2026-10-19T10:00:00Z')].map((r) => ({ ...r, source: verdictSourceOfEvidence(r.evidence) })), target }).verdict).toBe('pass');
  });
});
