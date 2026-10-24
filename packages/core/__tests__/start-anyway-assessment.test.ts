import { describe, it, expect } from 'bun:test';
import {
  START_ANYWAY_ASSESSED_KEY,
  START_ANYWAY_BRIEF_KEY,
  START_ANYWAY_PARK_KEY,
  needsAssessmentBeforeEdit,
  parseAssessment,
  resumeInstruction,
  startAnywayEditRefusal,
} from '../start-anyway';

// Start anyway (spec 36df686b r1): the agent's recorded assessment gates edits
// (R-4, AC-9) and returns with the resume (R-10).
const BRIEF_AT = '2026-10-23T10:00:00.000Z';
const ASSESSMENT = { needs: 'the parser interface', canProceed: 'the tests', uncertainty: 'unknown', nextStep: 'wait for it to merge' };

describe('Start anyway: the recorded assessment', () => {
  it('parses all four fields and names the first one missing', () => {
    expect(parseAssessment(ASSESSMENT)).toEqual({ ok: true, assessment: ASSESSMENT });
    const missing = parseAssessment({ ...ASSESSMENT, uncertainty: ' ' });
    expect(missing.ok).toBe(false);
    expect(!missing.ok && missing.error).toContain('assessment.uncertainty');
    expect(parseAssessment(null).ok).toBe(false);
  });

  it('AC-9: edits wait until an assessment is recorded after the claim-time brief', () => {
    const brief = { [START_ANYWAY_BRIEF_KEY]: { at: BRIEF_AT } };
    expect(needsAssessmentBeforeEdit(brief)).toBe(true);
    expect(startAnywayEditRefusal(brief)?.code).toBe('assessment_required');
    // Recorded with update_progress, or carried by a park, after the brief: edits go ahead.
    expect(needsAssessmentBeforeEdit({ ...brief, [START_ANYWAY_ASSESSED_KEY]: { at: '2026-10-23T10:01:00.000Z' } })).toBe(false);
    expect(needsAssessmentBeforeEdit({ ...brief, [START_ANYWAY_PARK_KEY]: { at: '2026-10-23T10:01:00.000Z' } })).toBe(false);
    // An assessment from before a newer Start anyway does not count for it.
    expect(needsAssessmentBeforeEdit({ ...brief, [START_ANYWAY_ASSESSED_KEY]: { at: '2026-10-22T10:00:00.000Z' } })).toBe(true);
  });

  it('a task never started anyway is never gated', () => {
    expect(needsAssessmentBeforeEdit({})).toBe(false);
    expect(needsAssessmentBeforeEdit(null)).toBe(false);
    expect(startAnywayEditRefusal({ waitExit: { at: BRIEF_AT } })).toBeNull();
  });

  it('R-10: the resume carries the structured assessment saved with the park', () => {
    const text = resumeInstruction({ blockerTaskId: 'up-1', reason: 'needs the parser', assessment: ASSESSMENT });
    expect(text).toContain('needs the parser');
    for (const v of Object.values(ASSESSMENT)) expect(text).toContain(v);
    expect(resumeInstruction({ blockerTaskId: 'up-1', reason: 'r' })).not.toContain('nextStep:');
  });
});
