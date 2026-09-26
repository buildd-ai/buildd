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
