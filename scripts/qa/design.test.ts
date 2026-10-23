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
    expect(s.get('phone-mission')).toEqual({ id: 'phone-mission', viewport: { width: 390, height: 844 }, theme: 'light' });
    expect(s.get('desktop-mission')).toEqual({ id: 'desktop-mission', viewport: { width: 1440, height: 900 }, theme: null });
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
    expect(s).toEqual([{ id: 'phone-verify', viewport: { width: 390, height: 844 }, theme: 'light', inFile: false }]);
  });
});
