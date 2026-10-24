import { describe, expect, it } from 'bun:test';
import { REVIEWER_REMEDY_DOCTRINE, REVIEWER_REMEDY_PROMPT_VERSION, checkRemedyFindings, tellsPersonToRun } from './reviewer-remedy';
import { parseReviewerOutput } from './reviewer-output';
import { findingsSection } from './reviewer';
import { REVIEWER_REMEDY_EVAL_CASES } from './prompt-evals/surfaces';
import { createHash } from 'node:crypto';

const out = (verdict: string, findings: unknown[]) => ({ verdict, confidence: 0.9, summary: 's', findings });

describe('remedy findings', () => {
  const c = REVIEWER_REMEDY_EVAL_CASES[0];

  it('eval case: the expected finding names the capability and sends no person to run with a DB', () => {
    expect(c.expectedFinding.title).toContain('model.inference');
    expect(tellsPersonToRun(c.expectedFinding.title)).toBe(false);
    expect(checkRemedyFindings(out('escalate', [c.expectedFinding])).ok).toBe(true);
  });

  it('eval case: the person-runs-it shape is rejected', () => {
    expect(tellsPersonToRun(c.badFinding.title)).toBe(true);
    const r = checkRemedyFindings(out('escalate', [c.badFinding]));
    expect(r.ok).toBe(false);
  });

  it('capability_gap with no resolve_capability evidence is rejected, not posted', () => {
    const r = parseReviewerOutput(out('escalate', [{ title: 'Missing capability X', remedyClass: 'capability_gap' }]));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('remedyEvidence');
  });

  it('operational_run needs evidence too', () => {
    expect(checkRemedyFindings(out('escalate', [{ title: 't', remedyClass: 'operational_run' }])).ok).toBe(false);
  });

  it('a genuine person_decision is unchanged and still escalates', () => {
    const r = parseReviewerOutput(out('escalate', [{ title: 'Choose which pricing tier ships first', remedyClass: 'person_decision' }]));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.output.verdict).toBe('escalate');
  });

  it('an escalation finding without a remedyClass is rejected; request-changes without one is not', () => {
    expect(checkRemedyFindings(out('escalate', [{ title: 't' }])).ok).toBe(false);
    expect(checkRemedyFindings(out('request-changes', [{ title: 't' }])).ok).toBe(true);
  });

  it('an unknown remedyClass is rejected', () => {
    expect(checkRemedyFindings(out('request-changes', [{ title: 't', remedyClass: 'vibes' }])).ok).toBe(false);
  });
});

describe('remedy doctrine prompt', () => {
  it('reaches the findings section and names every class', () => {
    const s = findingsSection(undefined);
    for (const k of ['code_fix', 'person_decision', 'capability_gap', 'operational_run', 'resolve_capability']) expect(s).toContain(k);
  });

  // Pins the text to its version: edit the doctrine, bump REVIEWER_REMEDY_PROMPT_VERSION and this hash together.
  it('is versioned: a text change needs a version bump', () => {
    expect([REVIEWER_REMEDY_PROMPT_VERSION, createHash('sha256').update(REVIEWER_REMEDY_DOCTRINE).digest('hex').slice(0, 12)]).toEqual(['v1', '0fdf3e754d0d']);
  });
});
