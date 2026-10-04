import { describe, expect, it } from 'bun:test';
import {
  MAX_EVIDENCE_REFS,
  MAX_OBSERVED_CHARS,
  VERIFICATION_SEVERITIES,
  VERIFICATION_VERDICTS,
  evidenceShortfall,
  maxSeverity,
  missingCapabilities,
  runVerificationCheck,
  severityRank,
  summarizeVerificationResults,
  verificationSignature,
  type VerificationCheck,
} from './verification-check';
import { FINDING_SEVERITIES } from './post-session-quality';

const NOW = new Date('2026-10-04T12:00:00Z');

function check(over: Partial<VerificationCheck<{ n: number }>> = {}): VerificationCheck<{ n: number }> {
  return {
    id: 'positive_number',
    version: 1,
    invariant: 'n is positive',
    subject: { kind: 'worker', ref: 'w-1' },
    provenance: { flavor: 'test', origin: 'unit' },
    executor: {
      kind: 'deterministic',
      requires: [],
      run: input => (input.n > 0
        ? { verdict: 'pass', observed: `n=${input.n}` }
        : { verdict: 'fail', observed: `n=${input.n}`, evidenceRefs: [{ kind: 'value', ref: String(input.n) }] }),
    },
    evidenceRequirements: [],
    defaultSeverity: 'medium',
    ...over,
  };
}

const ctx = (n: number, extra: Partial<Parameters<typeof runVerificationCheck>[1]> = {}) => ({
  input: { n },
  evidence: {},
  capabilities: [],
  now: NOW,
  ...extra,
});

describe('vocabularies', () => {
  it('verdict semantics are the ADR four', () => {
    expect([...VERIFICATION_VERDICTS]).toEqual(['pass', 'fail', 'inconclusive', 'unsupported']);
  });

  it('severity scale is the one post-session findings already persist', () => {
    expect([...VERIFICATION_SEVERITIES]).toEqual([...FINDING_SEVERITIES]);
  });

  it('ranks severity critical first', () => {
    expect(severityRank('critical')).toBeLessThan(severityRank('low'));
    expect(maxSeverity('low', 'high')).toBe('high');
    expect(maxSeverity('critical', 'medium')).toBe('critical');
  });
});

describe('verificationSignature', () => {
  it('is deterministic and order-sensitive', () => {
    expect(verificationSignature(['a', 'b'])).toBe(verificationSignature(['a', 'b']));
    expect(verificationSignature(['a', 'b'])).not.toBe(verificationSignature(['b', 'a']));
  });

  it('normalizes case and whitespace so trivial variants dedupe', () => {
    expect(verificationSignature(['  OOM_Killed '])).toBe(verificationSignature(['oom_killed']));
  });

  it('does not collide on joined boundaries', () => {
    expect(verificationSignature(['ab', 'c'])).not.toBe(verificationSignature(['a', 'bc']));
  });
});

describe('capability matching', () => {
  it('names what the executor needs and the host lacks', () => {
    expect(missingCapabilities(['transcript', 'db'], ['db'])).toEqual(['transcript']);
    expect(missingCapabilities([], [])).toEqual([]);
  });
});

describe('evidenceShortfall', () => {
  it('absent evidence never satisfies a requirement', () => {
    expect(evidenceShortfall([{ key: 'transcript.early', need: 'partial' }], {})).toEqual([
      { key: 'transcript.early', need: 'partial', have: 'absent' },
    ]);
  });

  it('partial satisfies partial but not complete', () => {
    expect(evidenceShortfall([{ key: 't', need: 'partial' }], { t: 'partial' })).toEqual([]);
    expect(evidenceShortfall([{ key: 't', need: 'complete' }], { t: 'partial' })).toEqual([
      { key: 't', need: 'complete', have: 'partial' },
    ]);
  });
});

describe('runVerificationCheck', () => {
  it('passes and fails per the executor, carrying identity and provenance', () => {
    const pass = runVerificationCheck(check(), ctx(3));
    expect(pass.verdict).toBe('pass');
    expect(pass.checkId).toBe('positive_number');
    expect(pass.checkVersion).toBe(1);
    expect(pass.subject).toEqual({ kind: 'worker', ref: 'w-1' });
    expect(pass.provenance).toMatchObject({ flavor: 'test', origin: 'unit', executor: 'deterministic', ranAt: NOW.toISOString() });

    const fail = runVerificationCheck(check(), ctx(-1));
    expect(fail.verdict).toBe('fail');
    expect(fail.severity).toBe('medium');
    expect(fail.evidenceRefs).toEqual([{ kind: 'value', ref: '-1' }]);
    expect(fail.observed).toBe('n=-1');
  });

  it('is unsupported when a required capability is missing — the executor never runs', () => {
    let ran = false;
    const c = check({ executor: { kind: 'transcript', requires: ['transcript_reader'], run: () => { ran = true; return { verdict: 'fail' }; } } });
    const r = runVerificationCheck(c, ctx(-1));
    expect(r.verdict).toBe('unsupported');
    expect(r.reason).toBe('missing_capability:transcript_reader');
    expect(ran).toBe(false);
  });

  it('is inconclusive when required evidence is missing or partial — never asserted', () => {
    let ran = false;
    const c = check({
      evidenceRequirements: [{ key: 'transcript.early', need: 'complete' }],
      executor: { kind: 'deterministic', requires: [], run: () => { ran = true; return { verdict: 'fail' }; } },
    });
    const r = runVerificationCheck(c, ctx(-1, { evidence: { 'transcript.early': 'partial' } }));
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toBe('evidence_insufficient:transcript.early');
    expect(r.evidenceShortfall).toEqual([{ key: 'transcript.early', need: 'complete', have: 'partial' }]);
    expect(ran).toBe(false);
  });

  it('runs when evidence is sufficient', () => {
    const c = check({ evidenceRequirements: [{ key: 'transcript.early', need: 'complete' }] });
    expect(runVerificationCheck(c, ctx(-1, { evidence: { 'transcript.early': 'complete' } })).verdict).toBe('fail');
  });

  it('a throwing executor is inconclusive, not a crash and not a fail', () => {
    const c = check({ executor: { kind: 'deterministic', requires: [], run: () => { throw new Error('boom with secret sk-123'); } } });
    const r = runVerificationCheck(c, ctx(1));
    expect(r.verdict).toBe('inconclusive');
    expect(r.reason).toBe('executor_error');
    expect(JSON.stringify(r)).not.toContain('sk-123');
  });

  it('a malformed executor verdict is inconclusive', () => {
    const c = check({ executor: { kind: 'deterministic', requires: [], run: () => ({ verdict: 'maybe' as never }) } });
    expect(runVerificationCheck(c, ctx(1)).verdict).toBe('inconclusive');
  });

  it('bounds observed text, evidence refs and confidence', () => {
    const refs = Array.from({ length: 40 }, (_, i) => ({ kind: 'k', ref: `r${i}` }));
    const c = check({
      executor: { kind: 'deterministic', requires: [], run: () => ({ verdict: 'fail', observed: 'x'.repeat(5000), evidenceRefs: refs, confidence: 7 }) },
    });
    const r = runVerificationCheck(c, ctx(1));
    expect(r.observed!.length).toBeLessThanOrEqual(MAX_OBSERVED_CHARS);
    expect(r.evidenceRefs.length).toBe(MAX_EVIDENCE_REFS);
    expect(r.confidence).toBe(1);
  });

  it('a NaN confidence is unknown, not zero', () => {
    const c = check({ executor: { kind: 'deterministic', requires: [], run: () => ({ verdict: 'fail', confidence: Number.NaN }) } });
    expect(runVerificationCheck(c, ctx(1)).confidence).toBeNull();
  });

  it('signature keys on check identity + executor parts, never on the subject', () => {
    const c = check({ executor: { kind: 'deterministic', requires: [], run: () => ({ verdict: 'fail', signatureParts: ['oom'] }) } });
    const a = runVerificationCheck(c, ctx(1));
    const b = runVerificationCheck({ ...c, subject: { kind: 'worker', ref: 'w-2' } }, ctx(1));
    expect(a.signature).toBe(b.signature);
    expect(a.signature).toBe(verificationSignature(['positive_number', 'oom']));
    expect(a.recurrenceKey).toBe('positive_number');
  });

  it('executor may override severity and recurrence key', () => {
    const c = check({
      executor: { kind: 'deterministic', requires: [], run: () => ({ verdict: 'fail', severity: 'critical', recurrenceKey: 'family' }) },
    });
    const r = runVerificationCheck(c, ctx(1));
    expect(r.severity).toBe('critical');
    expect(r.recurrenceKey).toBe('family');
  });

  it('non-fail verdicts carry no severity', () => {
    expect(runVerificationCheck(check(), ctx(1)).severity).toBeNull();
  });
});

describe('summarizeVerificationResults', () => {
  it('counts verdicts for readout/history', () => {
    const rs = [runVerificationCheck(check(), ctx(1)), runVerificationCheck(check(), ctx(-1)), runVerificationCheck(check(), ctx(-2))];
    expect(summarizeVerificationResults(rs)).toEqual({ total: 3, pass: 1, fail: 2, inconclusive: 0, unsupported: 0 });
  });
});
