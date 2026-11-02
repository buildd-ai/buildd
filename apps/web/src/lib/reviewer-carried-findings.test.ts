import { describe, expect, it } from 'bun:test';
import {
  admitsUnverified,
  applyCarriedFindingsGate,
  carriedFindingsOfContext,
  carriedFindingsSection,
  parseCarriedFindingChecks,
  type CarriedFinding,
} from './reviewer-carried-findings';

const design: CarriedFinding = {
  id: 'aaaaaaaa-1111-2222-3333-444444444444', title: 'No design comparison on the real route', path: null, line: null,
  remedyClass: 'evidence', evidence: { criterionId: 'AC-3', screen: 'queue', route: '/app/queue' },
};
const code: CarriedFinding = { id: 'bbbbbbbb-1111-2222-3333-444444444444', title: 'off by one', path: 'z.ts', line: 9, remedyClass: 'code_fix' };

describe('carriedFindingsOfContext', () => {
  it('reads the findings a trunk fix carries and drops malformed entries', () => {
    expect(carriedFindingsOfContext({ carriedFindings: [design, code, { id: 'x' }, null, 'nope'] })).toEqual([design, code]);
  });
  it('is empty for a task that carries none', () => {
    expect(carriedFindingsOfContext({})).toEqual([]);
    expect(carriedFindingsOfContext(null)).toEqual([]);
  });
});

describe('carriedFindingsSection', () => {
  it('lists each finding as required evidence and says an unverified approve is held', () => {
    const s = carriedFindingsSection([design, code], 5534);
    expect(s).toContain('## Findings carried from PR #5534 (required evidence)');
    expect(s).toContain(`\`${design.id}\` No design comparison on the real route`);
    expect(s).toContain('compare design screen queue with the built page at /app/queue');
    expect(s).toContain(`\`${code.id}\` off by one (z.ts:9)`);
    expect(s).toContain('carriedFindings');
  });
  it('is empty when nothing is carried, so other reviews are byte-identical', () => {
    expect(carriedFindingsSection([], 1)).toBe('');
  });
});

describe('admitsUnverified', () => {
  it.each([
    "I couldn't check the design comparisons the review asked for",
    'I could not verify the route at the head',
    'was not able to capture the screen',
    'did not run the tests',
    "can't fully confirm the layout",
  ])('reads "%s" as an admission', (t) => expect(admitsUnverified(t)).toBe(true));
  it.each([
    'Fixes the layout; tests pass.',
    'I did not see any regressions.',
    'Could not find a problem with the change.',
  ])('does not read "%s" as one', (t) => expect(admitsUnverified(t)).toBe(false));
});

describe('applyCarriedFindingsGate (f8a7a088)', () => {
  const checks = (o: Array<{ id: string; verified: boolean; how?: string }>) => parseCarriedFindingChecks({ carriedFindings: o });

  it('the incident: an approve at 0.65 saying it could not check the design comparison is not an approve', () => {
    const r = applyCarriedFindingsGate({
      verdict: 'approve', carried: [design], checks: [],
      said: ["Approve: the four-line QueueBoard change is right. I couldn't check the design comparisons the review asked for."],
    });
    expect(r.verdict).toBe('request-changes');
    expect(r.findings).toEqual([{
      title: 'Compare screen queue with the built page (carried: No design comparison on the real route)',
      remedyClass: 'evidence', evidence: { criterionId: 'AC-3', screen: 'queue', route: '/app/queue' },
    }]);
    expect(r.reason).toContain('buildd captures it');
  });

  it('an unverified code finding escalates, naming it', () => {
    const r = applyCarriedFindingsGate({ verdict: 'approve', carried: [design, code], checks: checks([{ id: design.id, verified: true, how: 'compared shot art-1' }]) });
    expect(r.verdict).toBe('escalate');
    expect(r.reason).toContain('bbbbbbbb "off by one"');
  });

  it('every carried finding verified, with how, and no admission: the approve stands', () => {
    const r = applyCarriedFindingsGate({
      verdict: 'approve', carried: [design, code],
      checks: checks([{ id: design.id, verified: true, how: 'compared screenshot art-1 of /app/queue' }, { id: code.id.slice(0, 8), verified: true, how: 'read z.ts:9, ran its test' }]),
      said: ['Both carried findings are fixed.'],
    });
    expect(r).toEqual({ verdict: 'approve', reason: null, findings: [] });
  });

  it('verified without saying how is not verified', () => {
    expect(applyCarriedFindingsGate({ verdict: 'approve', carried: [code], checks: checks([{ id: code.id, verified: true }]) }).verdict).toBe('escalate');
  });

  it('all verified but the summary says it could not check something: escalate', () => {
    const r = applyCarriedFindingsGate({
      verdict: 'approve', carried: [code], checks: checks([{ id: code.id, verified: true, how: 'read z.ts:9' }]),
      said: ['Looks right, though I was not able to run the suite.'],
    });
    expect(r.verdict).toBe('escalate');
  });

  it('other verdicts, and tasks that carry nothing, pass through', () => {
    expect(applyCarriedFindingsGate({ verdict: 'request-changes', carried: [code], checks: [] }).verdict).toBe('request-changes');
    expect(applyCarriedFindingsGate({ verdict: 'approve', carried: [], checks: [], said: ["couldn't check"] }).verdict).toBe('approve');
  });
});
