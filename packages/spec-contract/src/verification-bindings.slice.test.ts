import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { criterionRecords, otherTextBySection } from './criterion-records';
import {
  MAX_VERIFICATION_SCENARIOS, criterionVerifications, criterionVerificationCoverage, criterionVerificationScenarios, verificationDeclarationError,
  type VerificationBinding,
} from './verification-bindings';

const action: VerificationBinding = { id: 'ui.actions_match_state', version: 1, profile: 'buildd.enterprise@1', mode: 'required' };
const clarity: VerificationBinding = { id: 'ui.card_clarity', version: 1, profile: 'buildd.enterprise@1', mode: 'advisory' };
const line = (value: unknown) => `  verify: ${JSON.stringify(value)}`;

describe('criterionVerifications', () => {
  it('AC-1: binds registered checks to their governing R/AC criterion, including table rows', () => {
    const body = ['# UI', 'R-1: Actions reflect the current state.', line(action),
      '| Id | Requirement |', '|---|---|', '| AC-1 | Cards communicate the decision. |', line(clarity)].join('\n');
    const got = criterionVerifications(body);
    expect(got.map(({ criterionId, binding }) => ({ criterionId, binding }))).toEqual([
      { criterionId: 'R-1', binding: action }, { criterionId: 'AC-1', binding: clarity },
    ]);
    expect(got.every(v => /^[0-9a-f]{64}$/.test(v.fingerprint))).toBe(true);
  });

  it('AC-1: normalizes JSON property order while fingerprinting every policy field', () => {
    const a = criterionVerifications(`R-1: Actions.\n${line(action)}`)[0];
    const reordered = criterionVerifications('R-1: Actions.\n verify: {"mode":"required","profile":"buildd.enterprise@1","version":1,"id":"ui.actions_match_state"}')[0];
    const advisory = criterionVerifications(`R-1: Actions.\n${line({ ...action, mode: 'advisory' })}`)[0];
    const differentCheck = criterionVerifications(`R-1: Actions.\n${line({ ...action, id: 'ui.card_clarity' })}`)[0];
    expect(a.fingerprint).toBe(reordered.fingerprint);
    expect(a.fingerprint).not.toBe(advisory.fingerprint);
    expect(a.fingerprint).not.toBe(differentCheck.fingerprint);
  });

  it('AC-1: fingerprints the canonical full binding with portable SHA-256 identities', () => {
    for (const id of ['ui.actions_match_state', 'ui.card_clarity'] as const) {
      for (const mode of ['required', 'advisory'] as const) {
        const binding: VerificationBinding = { id, version: 1, profile: 'buildd.enterprise@1', mode };
        const expected = createHash('sha256').update(JSON.stringify(binding)).digest('hex');
        expect(criterionVerifications(`R-1: Actions.\n${line(binding)}`)[0].fingerprint).toBe(expected);
      }
    }
  });

  it('AC-1: rejects malformed, missing, unknown or unsupported configuration instead of dropping a required check', () => {
    const invalid = ['', 'not json', '[]', 'null', 'true', '"ui.actions_match_state"',
      JSON.stringify({ ...action, id: 'ui.invented' }), JSON.stringify({ ...action, version: 2 }),
      JSON.stringify({ ...action, version: '1' }), JSON.stringify({ ...action, profile: 'another-project@1' }),
      JSON.stringify({ ...action, mode: 'off' }), JSON.stringify({ ...action, model: 'caller-selected' }),
      JSON.stringify({ id: action.id, version: action.version, profile: action.profile })];
    for (const value of invalid) expect(() => criterionVerifications(`R-1: Actions.\n verify: ${value}`)).toThrow(/R-1/);
  });

  it('AC-1: allows distinct detectors but rejects repeated or conflicting registrations for the same detector', () => {
    expect(criterionVerifications(`R-1: Cards.\n${line(action)}\n${line(clarity)}`)).toHaveLength(2);
    expect(() => criterionVerifications(`R-1: Cards.\n${line(action)}\n${line(action)}`)).toThrow(/R-1/);
    expect(() => criterionVerifications(`R-1: Cards.\n${line(action)}\n${line({ ...action, mode: 'advisory' })}`)).toThrow(/R-1/);
  });

  it('AC-1: ignores examples, non-criteria, headings and repeated criterion definitions like check lines do', () => {
    const body = ['verify: not owned', 'R-1: First.', line(action),
      '```json', 'R-9: Example only.', 'verify: invalid example', '```',
      'D-1: Decision.', 'verify: invalid under decision', 'I-1: Invariant.', 'verify: invalid under invariant',
      '## Notes', 'verify: invalid under heading', 'R-1: Repeated.', 'verify: invalid repeat',
      'AC-1: Acceptance.', line(clarity)].join('\n');
    expect(criterionVerifications(body).map(v => v.criterionId)).toEqual(['R-1', 'AC-1']);
  });

  it('AC-1: binding changes leave criterion prose/hash unchanged but remain visible in revision text changes', () => {
    const before = `# UI\nR-1: Actions reflect current state.\n${line(action)}\n`;
    const after = before.replace('"required"', '"advisory"');
    const a = criterionRecords(before)[0]; const b = criterionRecords(after)[0];
    const hash = (s: string) => createHash('sha256').update(s).digest('hex');
    expect(a.text).toBe('Actions reflect current state.');
    expect(hash(a.text)).toBe(hash(b.text));
    expect(otherTextBySection(before).get('UI')).toContain('"required"');
    expect(otherTextBySection(after).get('UI')).toContain('"advisory"');
  });
});

describe('criterionVerificationCoverage', () => {
  it('AC-5: reports all R/AC criteria and declared check kinds without claiming any check ran or passed', () => {
    const body = ['# UI', 'R-1: Mechanical invariant.', ' check: bun run check-state',
      'R-2: Card clarity.', line(clarity), 'AC-1: Visual decision.', ' screen: review-desktop, review-phone',
      'AC-2: No registration yet.', 'D-1: A design choice.', 'I-1: Background.'].join('\n');
    expect(criterionVerificationCoverage(body)).toEqual([
      { criterionId: 'R-1', command: true, visual: false, registered: false, status: 'declared' },
      { criterionId: 'R-2', command: false, visual: false, registered: true, status: 'declared' },
      { criterionId: 'AC-1', command: false, visual: true, registered: false, status: 'declared' },
      { criterionId: 'AC-2', command: false, visual: false, registered: false, status: 'missing' },
    ]);
  });

  it('AC-5: combines multiple evidence/check kinds and refuses malformed verifier declarations', () => {
    const body = `R-1: Cards.\n check: bun run check-card\n screen: decision\n${line(action)}`;
    expect(criterionVerificationCoverage(body)).toEqual([
      { criterionId: 'R-1', command: true, visual: true, registered: true, status: 'declared' },
    ]);
    expect(() => criterionVerificationCoverage('R-1: Cards.\n verify: {"id":"unknown"}')).toThrow();
    expect(criterionVerificationCoverage('R-1: Not runnable.\n check: ``\n screen: ``')).toEqual([
      { criterionId: 'R-1', command: false, visual: false, registered: false, status: 'missing' },
    ]);
  });
});

describe('declared captures (scenarios:)', () => {
  it('R-1/R-16: reads each criterion\'s required captures by the verify ownership rule, deduped, in order', () => {
    const body = ['R-1: Actions.', line(action), ' scenarios: closed-pr@mobile, `closed-pr@desktop`', ' scenarios: closed-pr@mobile, open-pr@desktop',
      '```', 'R-9: Example.', 'scenarios: not owned', '```', 'R-2: Other.'].join('\n');
    expect([...criterionVerificationScenarios(body)]).toEqual([['R-1', [
      { scenarioId: 'closed-pr', viewport: 'mobile' }, { scenarioId: 'closed-pr', viewport: 'desktop' }, { scenarioId: 'open-pr', viewport: 'desktop' },
    ]]]);
  });

  it('R-3: a malformed or oversized scenario list throws instead of shrinking what a check must see', () => {
    for (const v of ['closed-pr', 'closed-pr@tablet', 'Closed@mobile', '@mobile', 'a@mobile,,b@mobile']) {
      expect(() => criterionVerificationScenarios(`R-1: Cards.\n scenarios: ${v}`)).toThrow(/R-1/);
    }
    const many = Array.from({ length: MAX_VERIFICATION_SCENARIOS + 1 }, (_, i) => `s${i}@mobile`).join(', ');
    expect(() => criterionVerificationScenarios(`R-1: Cards.\n scenarios: ${many}`)).toThrow(/at most/);
  });

  it('R-2: a stored body must declare its captures with every verify, and only with one', () => {
    expect(verificationDeclarationError('R-1: Plain.\n check: bun test')).toBeNull();
    expect(verificationDeclarationError(`R-1: Cards.\n${line(action)}\n scenarios: closed-pr@mobile`)).toBeNull();
    expect(verificationDeclarationError(`R-1: Cards.\n${line(action)}`)).toMatch(/^R-1: .*scenarios:/);
    expect(verificationDeclarationError('R-1: Cards.\n scenarios: closed-pr@mobile')).toMatch(/^R-1: .*no verify binding/);
    expect(verificationDeclarationError('R-1: Cards.\n verify: {"id":"ui.unknown"}\n scenarios: closed-pr@mobile')).toMatch(/^R-1: verify must be/);
    expect(verificationDeclarationError(`R-1: Cards.\n${line(action)}\n scenarios: closed-pr@tablet`)).toMatch(/^R-1: scenarios must be/);
  });
});
