import { describe, test, expect } from 'bun:test';
import { buildJudgeInput, assembleVerdicts, renderReport } from './judge-format';

const manifest = {
  routes: [
    {
      id: 'missions',
      path: '/app/missions',
      title: 'Missions list',
      specRef: '§2',
      expectations: [
        { id: 'm-list', desc: 'Missions are listed', specClaim: 'x' },
        { id: 'm-new', desc: 'New Mission button visible', specClaim: 'y' },
      ],
    },
    { id: 'home', path: '/app/home', title: 'Home', expectations: [{ id: 'h', desc: 'd' }] },
  ],
};

const cap = (o: Record<string, unknown>) => ({ url: 'u', capturedAt: 't', ...o });

describe('buildJudgeInput', () => {
  test('manifest captures carry their expectations', () => {
    const input = buildJudgeInput(manifest, [cap({ id: 'missions', path: '/app/missions', screenshotFile: 'missions.png', a11yFile: 'missions.json' })]);
    expect(input.routes).toHaveLength(1);
    expect(input.routes[0].title).toBe('Missions list');
    expect(input.routes[0].expectations.map(e => e.id)).toEqual(['m-list', 'm-new']);
    expect(input.routes[0].screenshot).toBe('screenshots/missions.png');
    expect(input.routes[0].a11y).toBe('a11y/missions.json');
    expect(input.routes[0].judge).toBe(true);
  });

  test('ad-hoc routes get the generic UI expectations', () => {
    const input = buildJudgeInput(manifest, [cap({ id: 'app-tasks-abc', path: '/app/tasks/abc', screenshotFile: 'app-tasks-abc.png' })]);
    expect(input.routes[0].title).toBe('/app/tasks/abc');
    expect(input.routes[0].expectations.length).toBeGreaterThan(0);
  });

  test('skipped / errored captures are not sent to the judge', () => {
    const input = buildJudgeInput(manifest, [
      cap({ id: 'home', path: '/app/home', skipped: true, skipReason: 'no id' }),
      cap({ id: 'missions', path: '/app/missions', error: 'timeout' }),
    ]);
    expect(input.routes.map(r => r.judge)).toEqual([false, false]);
  });
});

describe('assembleVerdicts', () => {
  const input = buildJudgeInput(manifest, [
    cap({ id: 'missions', path: '/app/missions', screenshotFile: 'missions.png' }),
    cap({ id: 'home', path: '/app/home', skipped: true, skipReason: 'no id' }),
  ]);

  test('maps pass/fail/unsure and derives the overall verdict itself', () => {
    const [m] = assembleVerdicts(input, {
      missions: { summary: 's', expectations: [{ id: 'm-list', verdict: 'pass', reason: 'r1' }, { id: 'm-new', verdict: 'fail', reason: 'r2' }] },
    });
    expect(m.overallVerdict).toBe('FAIL');
    expect(m.expectations.map(e => e.verdict)).toEqual(['MATCHES-SPEC', 'CONTRADICTED']);
    expect(m.expectations[1].evidence).toBe('r2');
    expect(m.screenshotFile).toBe('missions.png');
  });

  test('unsure → PARTIAL; all pass → PASS', () => {
    const partial = assembleVerdicts(input, {
      missions: { expectations: [{ id: 'm-list', verdict: 'pass', reason: '' }, { id: 'm-new', verdict: 'unsure', reason: '' }] },
    })[0];
    expect(partial.overallVerdict).toBe('PARTIAL');
    expect(partial.expectations[1].verdict).toBe('UNSURE');
    const pass = assembleVerdicts(input, {
      missions: { expectations: [{ id: 'm-list', verdict: 'pass', reason: '' }, { id: 'm-new', verdict: 'pass', reason: '' }] },
    })[0];
    expect(pass.overallVerdict).toBe('PASS');
  });

  test('a missing verdict file or expectation is an ERROR / UNSURE, never a silent PASS', () => {
    const [missing] = assembleVerdicts(input, {});
    expect(missing.overallVerdict).toBe('ERROR');
    const [partial] = assembleVerdicts(input, { missions: { expectations: [{ id: 'm-list', verdict: 'pass', reason: '' }] } });
    expect(partial.overallVerdict).toBe('PARTIAL');
    expect(partial.expectations.find(e => e.id === 'm-new')?.verdict).toBe('UNSURE');
  });

  test('garbage verdict values and huge reasons are sanitised', () => {
    const [m] = assembleVerdicts(input, {
      missions: { expectations: [{ id: 'm-list', verdict: 'LGTM', reason: 'x'.repeat(5000) }, { id: 'm-new', verdict: 'pass', reason: '' }] },
    });
    expect(m.expectations[0].verdict).toBe('UNSURE');
    expect(m.expectations[0].evidence.length).toBeLessThanOrEqual(400);
  });

  test('skipped captures stay SKIPPED', () => {
    expect(assembleVerdicts(input, {})[1].overallVerdict).toBe('SKIPPED');
  });
});

describe('renderReport', () => {
  test('keeps the report shape the PR-comment step consumes', () => {
    const input = buildJudgeInput(manifest, [cap({ id: 'missions', path: '/app/missions', screenshotFile: 'm.png' })]);
    const verdicts = assembleVerdicts(input, {
      missions: { summary: 'ok', expectations: [{ id: 'm-list', verdict: 'pass', reason: 'listed' }, { id: 'm-new', verdict: 'pass', reason: 'yes' }] },
    });
    const md = renderReport(verdicts);
    expect(md).toContain('# Visual QA Report');
    expect(md).toContain('**Overall: ✅ PASS**');
    expect(md).toContain('| Missions list | ✅ PASS | ok |');
    expect(md).toContain('**m-list** — `MATCHES-SPEC`');
  });
});

describe('design vs built', () => {
  const design = {
    design: { artifactId: '6356e80d-d2c5-4d52-878e-3025d23cf169', revision: 1, sha256: 'a'.repeat(64), source: 'url' as const },
    criteria: [
      { id: 'AC-4', text: 'The decision card, bar, summary line and the decision row are visible.', screens: ['phone-mission'] },
      { id: 'AC-1', text: 'Every task link goes to the task page.', screens: [] },
    ],
    shots: [{ screen: 'phone-mission', file: 'designs/phone-mission.png', viewport: { width: 390, height: 844 }, theme: 'light', href: '/app/artifacts/6356e80d-d2c5-4d52-878e-3025d23cf169?screen=phone-mission&revision=1' }],
    pairs: [{
      captureId: 'fx', route: '/app/dev/fixtures?state=mission-detail-compact', screen: 'phone-mission', criteria: ['AC-4'],
      designViewport: { width: 390, height: 844 }, builtViewport: { width: 390, height: 844 }, theme: 'light' as const, builtTheme: 'light' as const, themeMismatch: false,
      designImage: 'designs/phone-mission.png', builtImage: 'screenshots/fx.png', sideBySide: 'side-by-side/fx--phone-mission.png',
    }],
    unmatchedScreens: ['desktop-mission'],
  };
  const caps = [cap({ id: 'fx', path: '/app/dev/fixtures?state=mission-detail-compact', screenshotFile: 'fx.png' }), cap({ id: 'home', path: '/app/home', screenshotFile: 'home.png' })];

  test('a route paired with a screen carries both images, the criterion words and the ask', () => {
    const input = buildJudgeInput(manifest, caps, design);
    const fx = input.routes.find(r => r.id === 'fx')!;
    expect(fx.designChecks).toEqual([{
      id: 'design:phone-mission',
      screen: 'phone-mission',
      judge: true,
      design: 'designs/phone-mission.png',
      built: 'screenshots/fx.png',
      sideBySide: 'side-by-side/fx--phone-mission.png',
      designViewport: { width: 390, height: 844 },
      builtViewport: { width: 390, height: 844 },
      theme: 'light',
      criteria: [{ id: 'AC-4', text: 'The decision card, bar, summary line and the decision row are visible.' }],
      designHref: '/app/artifacts/6356e80d-d2c5-4d52-878e-3025d23cf169?screen=phone-mission&revision=1',
    }]);
    // The generic checks still run: a criterion with no screen is judged as today.
    expect(fx.expectations.length).toBeGreaterThan(0);
    expect(input.routes.find(r => r.id === 'home')!.designChecks).toBeUndefined();
    expect(input.instructions).toMatch(/layout, content order, words and states/);
    expect(input.instructions).toMatch(/not pixels/);
    expect(input.instructions).toMatch(/screen id/);
    expect(input.unmatchedScreens).toEqual(['desktop-mission']);
  });

  test('without a design the input is unchanged', () => {
    const input = buildJudgeInput(manifest, caps);
    expect(input.instructions).toBeUndefined();
    expect(input.routes.every(r => r.designChecks === undefined)).toBe(true);
  });

  test('a page shot in the other theme is not compared: Night/Day parity is its own check', () => {
    const input = buildJudgeInput(manifest, caps, { ...design, pairs: [{ ...design.pairs[0], builtTheme: 'dark' as const, themeMismatch: true }] });
    expect(input.routes.find(r => r.id === 'fx')!.designChecks![0]).toMatchObject({ judge: false, skipReason: expect.stringMatching(/theme/) });
  });

  test('the verdict cites the screen, keeps both images, and a difference fails the route', () => {
    const input = buildJudgeInput(manifest, caps, design);
    const verdicts = assembleVerdicts(input, {
      fx: {
        summary: 's',
        expectations: [{ id: 'renders', verdict: 'pass' }, { id: 'first-screen', verdict: 'pass' }, { id: 'no-overflow', verdict: 'pass' }, { id: 'tap-targets', verdict: 'pass' }],
        designChecks: [{ screen: 'phone-mission', verdict: 'fail', reason: 'The decision card sits below the bar.', differences: [{ kind: 'order', detail: 'decision card after the bar, design has it first' }] }],
      },
    }, caps);
    const fx = verdicts.find(v => v.id === 'fx')!;
    expect(fx.overallVerdict).toBe('FAIL');
    expect(fx.design).toEqual([{
      screen: 'phone-mission', verdict: 'CONTRADICTED', evidence: 'The decision card sits below the bar.',
      differences: [{ kind: 'order', detail: 'decision card after the bar, design has it first' }],
      criteria: ['AC-4'], designImage: 'designs/phone-mission.png', builtImage: 'screenshots/fx.png',
      sideBySide: 'side-by-side/fx--phone-mission.png', designHref: '/app/artifacts/6356e80d-d2c5-4d52-878e-3025d23cf169?screen=phone-mission&revision=1',
    }]);
    const report = renderReport(verdicts);
    expect(report).toContain('Design vs built');
    expect(report).toContain('**phone-mission** (AC-4)');
    expect(report).toContain('![Design · phone-mission](designs/phone-mission.png)');
    expect(report).toContain('![Built · fx](screenshots/fx.png)');
    expect(report).toContain('order: decision card after the bar');
  });

  test('a design check the judge skipped is unsure, never a pass', () => {
    const input = buildJudgeInput(manifest, caps, design);
    const verdicts = assembleVerdicts(input, {
      fx: { summary: 's', expectations: [{ id: 'renders', verdict: 'pass' }, { id: 'first-screen', verdict: 'pass' }, { id: 'no-overflow', verdict: 'pass' }, { id: 'tap-targets', verdict: 'pass' }] },
    }, caps);
    const fx = verdicts.find(v => v.id === 'fx')!;
    expect(fx.design![0]).toMatchObject({ screen: 'phone-mission', verdict: 'UNSURE' });
    expect(fx.overallVerdict).toBe('PARTIAL');
  });
});
