import { describe, expect, it } from 'bun:test';
import { applyDesignGate, isFixtureRoute, parseDesignChecks, renderDesignGuidance, screenNamedCriteria } from './reviewer-design';

const DESIGN = { kind: 'artifact', ref: 'art-1', version: '1' };
const BODY = '# Nav\n- AC-4: the mission page.\n  - screen: phone-mission, desktop-mission\n- AC-5: copy only.';
const REQUIRED = [{ criterionId: 'AC-4', screens: ['phone-mission', 'desktop-mission'] }];
const check = (over: Record<string, unknown> = {}) => ({
  criterionId: 'AC-4', screen: 'phone-mission', route: '/app/missions/:id', shotIds: ['s1'], matches: true, ...over,
});

describe('screenNamedCriteria', () => {
  it('lists the in-scope criteria that name screens, and only when the revision has a design', () => {
    expect(screenNamedCriteria({ body: BODY, design: DESIGN })).toEqual(REQUIRED);
    expect(screenNamedCriteria({ body: BODY, design: null })).toEqual([]);
    expect(screenNamedCriteria({ body: BODY, design: DESIGN, inScopeIds: ['AC-5'] })).toEqual([]);
  });
});

describe('applyDesignGate', () => {
  const both = [check(), check({ screen: 'desktop-mission' })];
  it('refuses approval with no design comparison: changes requested, naming the screens', () => {
    const r = applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: [], feedback: 'ok' });
    expect(r.verdict).toBe('request-changes');
    expect(r.feedback).toContain('AC-4: phone-mission, desktop-mission');
    expect(r.feedback).toContain('not evidence');
    expect(r.feedback).toStartWith('ok');
  });
  it('refuses approval when a screen has no shots of the route', () => {
    const r = applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: [check(), check({ screen: 'desktop-mission', shotIds: [] })] });
    expect(r.verdict).toBe('request-changes');
    expect(r.reason).toContain('desktop-mission');
  });
  it('a fixture route counts only with the state it stands in for', () => {
    const fx = (reason?: string) => [check({ route: '/app/dev/fixtures?state=mission', fixtureReason: reason }), check({ screen: 'desktop-mission' })];
    expect(applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: fx() }).verdict).toBe('request-changes');
    expect(applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: fx('needs a failed run') }).verdict).toBe('approve');
  });
  it('a mismatch the reviewer found is changes requested even with shots', () => {
    const r = applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: [check({ matches: false }), check({ screen: 'desktop-mission' })] });
    expect(r.verdict).toBe('request-changes');
    expect(r.reason).toContain('does not match');
  });
  it('approves with a real-route comparison for every named screen', () => {
    expect(applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: both })).toMatchObject({ verdict: 'approve', reason: null });
  });
  it('leaves a task with no screen-named criteria, and other verdicts, alone', () => {
    expect(applyDesignGate({ verdict: 'approve', required: [], checks: [] }).verdict).toBe('approve');
    expect(applyDesignGate({ verdict: 'escalate', required: REQUIRED, checks: [] }).verdict).toBe('escalate');
    expect(applyDesignGate({ verdict: 'request-changes', required: REQUIRED, checks: [] }).reason).toBeNull();
  });
});

describe('parseDesignChecks', () => {
  it('keeps well-formed entries; a missing matches is not a match', () => {
    const out = parseDesignChecks({ designChecks: [{ criterionId: 'AC-4', screen: 's', route: '/a', shotIds: ['x', 3] }, { screen: 'no id' }, null] });
    expect(out).toEqual([{ criterionId: 'AC-4', screen: 's', route: '/a', shotIds: ['x'], matches: false }]);
    expect(parseDesignChecks({})).toEqual([]);
  });
  it('recognises dev fixture routes', () => {
    expect(isFixtureRoute('/app/dev/fixtures?state=x')).toBe(true);
    expect(isFixtureRoute('/app/missions/:id')).toBe(false);
  });
});

describe('renderDesignGuidance', () => {
  it('is empty without a design or screen-named criteria', () => {
    expect(renderDesignGuidance({ design: null, criteria: REQUIRED })).toBe('');
    expect(renderDesignGuidance({ design: DESIGN, criteria: [] })).toBe('');
  });
});
