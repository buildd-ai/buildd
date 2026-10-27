import { describe, expect, test } from 'bun:test';
import { designScreensFromHtml, mapRoutesToScreens, parseDesignPlan, routePage, screenPage, screensToCapture } from './design';

const HTML = `<!doctype html><body>
<section id="phone-mission" data-screen="phone-mission" data-viewport="390x844" data-theme="light" aria-label="Phone">x</section>
<section data-screen='desktop-mission' data-viewport="1440x900">y</section>
<section data-screen="phone-task-running">z</section>
<section data-screen="coverage" data-viewport="1200x700">c</section>
</body>`;

const plan = (o: Record<string, unknown> = {}) => parseDesignPlan(JSON.stringify({
  design: { file: '/tmp/d.html', artifactId: '6356e80d-d2c5-4d52-878e-3025d23cf169', revision: 1, theme: 'light' },
  criteria: [
    { id: 'AC-4', text: 'The mission page shows the decision card and the bar.', screens: ['phone-mission', 'desktop-mission'] },
    { id: 'AC-6', screens: ['phone-task-running'] },
    { id: 'AC-1', text: 'Every task link goes to the task page.' },
  ],
  ...o,
}));

const cap = (id: string, path: string, width: number, o: Record<string, unknown> = {}) =>
  ({ id, path, screenshotFile: `${id}.png`, viewport: { width, height: width < 768 ? 844 : 900 }, ...o });

describe('parseDesignPlan', () => {
  test('takes the plan as JSON text and keeps only plain screen ids', () => {
    const p = plan();
    expect(p.design).toMatchObject({ file: '/tmp/d.html', revision: 1, theme: 'light' });
    expect(p.criteria.map((c) => [c.id, c.screens])).toEqual([['AC-4', ['phone-mission', 'desktop-mission']], ['AC-6', ['phone-task-running']], ['AC-1', []]]);
  });

  test('refuses a plan with no design source, two sources, an http url or a screen id that is not a slug', () => {
    expect(() => parseDesignPlan('{"design":{},"criteria":[]}')).toThrow(/file or design.url/);
    expect(() => parseDesignPlan('{"design":{"file":"a","url":"https://x"},"criteria":[]}')).toThrow(/not both/);
    expect(() => parseDesignPlan('{"design":{"url":"http://x/d.html"},"criteria":[]}')).toThrow(/https/);
    expect(() => parseDesignPlan('{"design":{"file":"a"},"criteria":[{"id":"AC-1","screens":["a\\"]"]}]}')).toThrow(/screen id/);
    expect(() => parseDesignPlan('{"design":{"file":"a"},"criteria":[],"routes":{"x":"no-slash"}}')).toThrow(/route/);
    expect(() => parseDesignPlan('not json')).toThrow(/QA_DESIGN/);
  });
});

describe('designScreensFromHtml', () => {
  test('reads each section\'s viewport and theme as text, falling back to the id prefix for the size', () => {
    const s = designScreensFromHtml(HTML);
    expect(s.get('phone-mission')).toEqual({ id: 'phone-mission', viewport: { width: 390, height: 844 }, theme: 'light', kind: 'page' });
    expect(s.get('desktop-mission')).toEqual({ id: 'desktop-mission', viewport: { width: 1440, height: 900 }, theme: null, kind: 'page' });
    expect(s.get('phone-task-running')?.viewport).toEqual({ width: 390, height: 844 });
    expect(s.get('coverage')?.viewport).toEqual({ width: 1200, height: 700 });
  });
});

describe('route and screen pages', () => {
  test('a route is named by its first segment under /app, singular; a screen by its id without the device', () => {
    expect(routePage('/app/missions/abc?layout=feed')).toBe('mission');
    expect(routePage('/app/tasks/abc')).toBe('task');
    expect(routePage('/app/home')).toBe('home');
    expect(screenPage('phone-mission')).toBe('mission');
    expect(screenPage('desktop-task-running')).toBe('task-running');
    expect(screenPage('coverage')).toBe('coverage');
  });
});

describe('mapRoutesToScreens', () => {
  const screens = designScreensFromHtml(HTML);

  test('pairs a route with the screens its criteria name, at the same device width', () => {
    const { pairs, unmatchedScreens } = mapRoutesToScreens(plan(), screens, [
      cap('mission-phone', '/app/missions/m1', 390),
      cap('mission-desk', '/app/missions/m1', 1440),
      cap('task-phone', '/app/tasks/t1', 390),
      cap('home', '/app/home', 390),
    ]);
    expect(pairs.map((p) => [p.captureId, p.screen, p.criteria])).toEqual([
      ['mission-phone', 'phone-mission', ['AC-4']],
      ['mission-desk', 'desktop-mission', ['AC-4']],
      ['task-phone', 'phone-task-running', ['AC-6']],
    ]);
    expect(unmatchedScreens).toEqual([]);
    expect(pairs[0]).toMatchObject({ route: '/app/missions/m1', designViewport: { width: 390, height: 844 }, builtViewport: { width: 390, height: 844 }, theme: 'light' });
  });

  test('a criterion with no screen pairs nothing, so its route is judged as today', () => {
    const { pairs } = mapRoutesToScreens(plan({ criteria: [{ id: 'AC-1', screens: [] }] }), screens, [cap('m', '/app/missions/m1', 390)]);
    expect(pairs).toEqual([]);
  });

  test('an explicit route wins over the name match, and matches a :id pattern or the exact path with its query', () => {
    const fixture = '/app/dev/fixtures?state=mission-detail-compact&variant=building';
    const { pairs } = mapRoutesToScreens(plan({ routes: { 'phone-mission': fixture, 'desktop-mission': '/app/missions/:id' } }), screens, [
      cap('fx', fixture, 390),
      cap('fx-other', '/app/dev/fixtures?state=home-cards', 390),
      cap('mission-phone', '/app/missions/m1', 390),
      cap('mission-desk', '/app/missions/m1', 1440),
    ]);
    expect(pairs.map((p) => [p.captureId, p.screen])).toEqual([['fx', 'phone-mission'], ['mission-desk', 'desktop-mission']]);
  });

  test('a screen no capture matches is reported, never silently dropped', () => {
    const { pairs, unmatchedScreens } = mapRoutesToScreens(plan(), screens, [cap('mission-phone', '/app/missions/m1', 390)]);
    expect(pairs.map((p) => p.screen)).toEqual(['phone-mission']);
    expect(unmatchedScreens).toEqual(['desktop-mission', 'phone-task-running']);
  });

  test('a skipped or failed capture pairs nothing; a capture with no viewport uses the fallback', () => {
    const { pairs } = mapRoutesToScreens(plan(), screens, [
      { id: 'a', path: '/app/missions/m1', skipped: true },
      { id: 'b', path: '/app/missions/m1', error: 'timeout' },
      { id: 'c', path: '/app/missions/m1', screenshotFile: 'c.png' },
    ], { fallbackViewport: { width: 1440, height: 900 } });
    expect(pairs.map((p) => [p.captureId, p.screen])).toEqual([['c', 'desktop-mission']]);
  });

  test('a capture in the other theme is paired but flagged: Night/Day parity is a separate check', () => {
    const { pairs } = mapRoutesToScreens(plan(), screens, [cap('m', '/app/missions/m1', 390, { theme: 'dark' })]);
    expect(pairs[0]).toMatchObject({ screen: 'phone-mission', theme: 'light', builtTheme: 'dark', themeMismatch: true });
  });
});

describe('screensToCapture', () => {
  test('every screen a criterion names, once, in criterion order, with its viewport and theme', () => {
    const s = screensToCapture(plan(), designScreensFromHtml(HTML));
    expect(s.map((x) => [x.id, x.viewport, x.theme])).toEqual([
      ['phone-mission', { width: 390, height: 844 }, 'light'],
      ['desktop-mission', { width: 1440, height: 900 }, 'light'],
      ['phone-task-running', { width: 390, height: 844 }, 'light'],
    ]);
  });

  test('a named screen the file lacks is still listed, so the capture records it missing', () => {
    const s = screensToCapture(plan({ criteria: [{ id: 'AC-9', screens: ['phone-verify'] }] }), designScreensFromHtml(HTML));
    expect(s).toEqual([{ id: 'phone-verify', viewport: { width: 390, height: 844 }, theme: 'light', inFile: false, kind: 'page' }]);
  });
});

describe('component screens (R-17)', () => {
  const COMP_HTML = `<section data-screen="c-stage-meter" data-viewport="480x160" data-kind="component" data-code="apps/web/src/components/UiStageMeter.tsx">m</section>
<section data-screen="phone-activity" data-viewport="390x844">a</section>`;
  const inFile = designScreensFromHtml(COMP_HTML);
  const cplan = (o: Record<string, unknown> = {}) => parseDesignPlan(JSON.stringify({
    design: { file: '/tmp/d.html' },
    criteria: [{ id: 'AC-14', text: 'The stage meter shows each stage.', screens: ['c-stage-meter'] }, { id: 'AC-2', screens: ['phone-activity'] }],
    ...o,
  }));
  const fx = (state: string, width: number, id = state) => ({ id, path: `/app/dev/fixtures?state=${state}`, screenshotFile: `${id}.png`, viewport: { width, height: 900 } });

  test('the file and the plan say what a screen is; the plan wins, and a screen is a page unless it says otherwise', () => {
    expect(inFile.get('c-stage-meter')).toMatchObject({ kind: 'component', code: 'apps/web/src/components/UiStageMeter.tsx' });
    expect(inFile.get('phone-activity')).toMatchObject({ kind: 'page' });
    const s = screensToCapture(cplan({ screens: { 'phone-activity': { kind: 'component', code: 'apps/web/src/components/Feed.tsx' } } }), inFile);
    expect(s.map((x) => [x.id, x.kind, x.code ?? null])).toEqual([
      ['c-stage-meter', 'component', 'apps/web/src/components/UiStageMeter.tsx'],
      ['phone-activity', 'component', 'apps/web/src/components/Feed.tsx'],
    ]);
  });

  test('refuses a plan screen with an unknown kind or a code that is not a repo path', () => {
    expect(() => cplan({ screens: { 'c-stage-meter': { kind: 'widget' } } })).toThrow('screens.c-stage-meter.kind');
    expect(() => cplan({ screens: { 'c-stage-meter': { code: '../etc/passwd' } } })).toThrow('screens.c-stage-meter.code');
  });

  test('a component screen is compared with its dev fixture at the screen\'s width, never with a real route', () => {
    const { pairs, unmatchedScreens } = mapRoutesToScreens(cplan({ routes: { 'c-stage-meter': '/app/dev/fixtures?state=stage-meter' } }), inFile, [
      { id: 'activity', path: '/app/activity', screenshotFile: 'activity.png', viewport: { width: 480, height: 900 } },
      fx('stage-meter', 1440, 'wide'),
      fx('stage-meter', 480),
      cap('act-phone', '/app/activity', 390),
    ]);
    expect(pairs.map((p) => [p.captureId, p.screen, p.kind, p.fixture ?? null])).toEqual([
      ['activity', 'phone-activity', 'page', null],
      ['stage-meter', 'c-stage-meter', 'component', '/app/dev/fixtures?state=stage-meter'],
      ['act-phone', 'phone-activity', 'page', null],
    ]);
    expect(unmatchedScreens).toEqual([]);
  });

  test('a fixture per component state: every route listed for the screen is compared', () => {
    const { pairs } = mapRoutesToScreens(cplan({ routes: { 'c-stage-meter': ['/app/dev/fixtures?state=stage-meter&variant=idle', '/app/dev/fixtures?state=stage-meter&variant=failed'] } }), inFile, [
      fx('stage-meter&variant=idle', 480, 'idle'),
      fx('stage-meter&variant=failed', 480, 'failed'),
      fx('stage-meter&variant=running', 480, 'running'),
    ]);
    expect(pairs.map((p) => [p.captureId, p.fixture])).toEqual([
      ['idle', '/app/dev/fixtures?state=stage-meter&variant=idle'],
      ['failed', '/app/dev/fixtures?state=stage-meter&variant=failed'],
    ]);
  });

  test('with no route given, the fixture is found by the screen id or the code component\'s name', () => {
    const byName = mapRoutesToScreens(cplan(), inFile, [fx('stage-meter', 480), fx('home-cards', 480)]);
    expect(byName.pairs.map((p) => p.captureId)).toEqual(['stage-meter']);
    const byCode = mapRoutesToScreens(cplan(), inFile, [fx('ui-stage-meter', 480)]);
    expect(byCode.pairs.map((p) => p.captureId)).toEqual(['ui-stage-meter']);
  });

  test('a component screen mapped to a real route is not compared there: it stays unmatched', () => {
    const { pairs, unmatchedScreens } = mapRoutesToScreens(cplan({ routes: { 'c-stage-meter': '/app/activity' } }), inFile, [
      { id: 'activity', path: '/app/activity', screenshotFile: 'activity.png', viewport: { width: 480, height: 900 } },
    ]);
    expect(pairs.map((p) => p.screen)).toEqual(['phone-activity']);
    expect(unmatchedScreens).toEqual(['c-stage-meter']);
  });
});
