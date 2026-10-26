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
  // Designs in buildd AC-17 (replaces AC-10): no comparison is evidence buildd captures, never a builder's round.
  it('an approve with no design comparison does not approve the head: one evidence finding per screen, the builder asked nothing', () => {
    const r = applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: [], feedback: 'ok' });
    expect(r.verdict).toBe('request-changes');
    expect(r.findings).toEqual([
      { title: 'Compare AC-4 screen phone-mission with the built page', remedyClass: 'evidence', evidence: { criterionId: 'AC-4', screen: 'phone-mission', route: null } },
      { title: 'Compare AC-4 screen desktop-mission with the built page', remedyClass: 'evidence', evidence: { criterionId: 'AC-4', screen: 'desktop-mission', route: null } },
    ]);
    // The feedback the builder would read is the reviewer's own, with no request for screenshots.
    expect(r.feedback).toBe('ok');
    expect(r.reason).toContain('AC-4: phone-mission, desktop-mission');
  });
  it('a screen with no shots of the route is evidence, at the route the reviewer named', () => {
    const r = applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: [check(), check({ screen: 'desktop-mission', shotIds: [] })] });
    expect(r.verdict).toBe('request-changes');
    expect(r.findings).toEqual([{ title: 'Compare AC-4 screen desktop-mission with the built page', remedyClass: 'evidence', evidence: { criterionId: 'AC-4', screen: 'desktop-mission', route: '/app/missions/:id' } }]);
  });
  it('a fixture route counts only with the state it stands in for', () => {
    const fx = (reason?: string) => [check({ route: '/app/dev/fixtures?state=mission', fixtureReason: reason }), check({ screen: 'desktop-mission' })];
    expect(applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: fx() }).verdict).toBe('request-changes');
    expect(applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: fx('needs a failed run') }).verdict).toBe('approve');
  });
  it('a mismatch the reviewer found with shots is a code finding: the builder can fix the page', () => {
    const r = applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: [check({ matches: false }), check({ screen: 'desktop-mission' })] });
    expect(r.verdict).toBe('request-changes');
    expect(r.reason).toContain('does not match');
    expect(r.findings).toEqual([{ title: 'The page at /app/missions/:id does not match AC-4 screen phone-mission', remedyClass: 'code_fix' }]);
  });
  it('approves with a real-route comparison for every named screen', () => {
    expect(applyDesignGate({ verdict: 'approve', required: REQUIRED, checks: both })).toMatchObject({ verdict: 'approve', reason: null, findings: [] });
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
  it('tells the reviewer buildd captures a missing comparison, and never to ask the builder for shots', () => {
    const text = renderDesignGuidance({ design: DESIGN, criteria: REQUIRED });
    expect(text).toContain('buildd captures');
    expect(text).not.toMatch(/builder'?s? (own )?screenshots/i);
    expect(text).not.toContain('request-changes');
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
    expect(real.findings[0]).toMatchObject({ remedyClass: 'evidence', evidence: { screen: 'c-stage-meter', route: null } });
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
