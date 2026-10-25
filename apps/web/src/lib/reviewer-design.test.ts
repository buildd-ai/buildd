import { describe, expect, it } from 'bun:test';
import { applyDesignGate, componentScreens, isFixtureRoute, parseDesignChecks, renderDesignGuidance, screenNamedCriteria, withScreenInfo } from './reviewer-design';

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

describe('component screens (R-17)', () => {
  const COMP = [{ criterionId: 'AC-14', screens: ['c-stage-meter'] }];
  const design = withScreenInfo(DESIGN, [{ id: 'c-stage-meter', name: 'Stage meter', viewport: '480x160', kind: 'component', code: 'apps/web/src/components/UiStageMeter.tsx' }]);
  const comp = (over: Record<string, unknown> = {}) => check({ criterionId: 'AC-14', screen: 'c-stage-meter', ...over });

  it("merges the design's screen kinds onto the pinned design", () => {
    expect(design.screens).toEqual([{ id: 'c-stage-meter', name: 'Stage meter', kind: 'component', code: 'apps/web/src/components/UiStageMeter.tsx' }]);
    expect(componentScreens(design)).toEqual(['c-stage-meter']);
    expect(componentScreens(DESIGN)).toEqual([]);
  });
  it('a component screen counts only on its dev fixture, with the state it shows; a real route does not count', () => {
    const gate = (c: Record<string, unknown>) => applyDesignGate({ verdict: 'approve', required: COMP, checks: [comp(c)], components: componentScreens(design) });
    const real = gate({ route: '/app/activity' });
    expect(real.verdict).toBe('request-changes');
    expect(real.reason).toContain('AC-14: c-stage-meter');
    expect(real.reason).toContain('component');
    expect(gate({ route: '/app/dev/fixtures?state=stage-meter' }).verdict).toBe('request-changes');
    expect(gate({ route: '/app/dev/fixtures?state=stage-meter', fixtureReason: 'the failed state' })).toMatchObject({ verdict: 'approve', reason: null });
  });
  it('the guidance sends a component screen to its fixture at its size and keeps page screens on the route', () => {
    const text = renderDesignGuidance({ design, criteria: [...COMP, ...REQUIRED] });
    expect(text).toContain('c-stage-meter (Stage meter; a component, code apps/web/src/components/UiStageMeter.tsx)');
    expect(text).toContain('/app/dev/fixtures');
    expect(text).toContain('fixtureReason');
    expect(renderDesignGuidance({ design: DESIGN, criteria: REQUIRED })).not.toContain('component');
  });
});
