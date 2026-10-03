import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  parseSelector,
  selectorString,
  validatePlan,
  parsePlan,
  planText,
  runSteps,
  isMutatingMethod,
  WAIT_MS_CAP,
  type Step,
} from './steps';

const forceStartPlan = (commit: boolean) => [{
  route: '/app/tasks/abc',
  states: [{
    key: 'force-start-dialog',
    steps: [
      { action: 'click', selector: 'role:button[name=Start Task]', ...(commit ? { commit: true } : {}) },
      { action: 'waitFor', selector: 'text:Force start' },
    ],
  }],
}];

describe('parseSelector', () => {
  it('reads every prefix, and a bare word as a testid', () => {
    expect(parseSelector('testid:task-header-status')).toEqual({ kind: 'testid', id: 'task-header-status' });
    expect(parseSelector('mission-detail')).toEqual({ kind: 'testid', id: 'mission-detail' });
    expect(parseSelector('role:button[name=Start Task]')).toEqual({ kind: 'role', role: 'button', name: 'Start Task' });
    expect(parseSelector('role:dialog')).toEqual({ kind: 'role', role: 'dialog' });
    expect(parseSelector('role:button[name="Force start"]')).toEqual({ kind: 'role', role: 'button', name: 'Force start' });
    expect(parseSelector('text:Force start')).toEqual({ kind: 'text', text: 'Force start' });
    expect(parseSelector('css:button')).toEqual({ kind: 'css', css: 'button' });
    expect(parseSelector('.fixed.inset-0')).toEqual({ kind: 'css', css: '.fixed.inset-0' });
  });

  it('rejects empty and malformed selectors', () => {
    expect(() => parseSelector('')).toThrow();
    expect(() => parseSelector('testid:')).toThrow();
    expect(() => parseSelector('role:button[label=x]')).toThrow(/role:<role>/);
  });

  it('keeps the storyboard manifest string for a bare word and a raw selector', () => {
    expect(selectorString('mission-task-row')).toBe('[data-testid="mission-task-row"]');
    expect(selectorString('text=Approve')).toBe('text=Approve');
    expect(selectorString('testid:x')).toBe('[data-testid="x"]');
  });
});

describe('validatePlan', () => {
  it('accepts the force-start plan on the sandbox, commit included', () => {
    const plan = validatePlan(forceStartPlan(true), { pageSource: 'sandbox' });
    expect(plan[0].states[0].key).toBe('force-start-dialog');
    expect(plan[0].states[0].steps[0].commit).toBe(true);
  });

  it('rejects a commit step on a preview, naming the route, state and step', () => {
    expect(() => validatePlan(forceStartPlan(true), { pageSource: 'vercel-preview' })).toThrow(
      /route "\/app\/tasks\/abc" state "force-start-dialog" steps\[0\] \(click role:button\[name=Start Task\]\) has commit: true/,
    );
  });

  it('accepts the same plan on a preview without the commit step', () => {
    expect(() => validatePlan(forceStartPlan(false), { pageSource: 'vercel-preview' })).not.toThrow();
  });

  it('treats states as optional', () => {
    expect(validatePlan([{ route: '/app/home' }], { pageSource: 'sandbox' })).toEqual([{ route: '/app/home', states: [] }]);
  });

  it('rejects actions outside the closed list', () => {
    expect(() => validatePlan([{ route: '/x', states: [{ key: 'a', steps: [{ action: 'evaluate', selector: 'x' }] }] }], { pageSource: 'sandbox' }))
      .toThrow(/action must be one of click, hover, fill, press, select, waitFor, waitMs/);
    expect(() => validatePlan([{ route: '/x', states: [{ key: 'a', steps: [{ action: 'goto', url: '/y' }] }] }], { pageSource: 'sandbox' }))
      .toThrow(/unknown field\(s\) url/);
  });

  it('rejects missing fields, bad keys and duplicates', () => {
    const one = (step: Record<string, unknown>) => [{ route: '/x', states: [{ key: 'a', steps: [step] }] }];
    const v = (p: unknown) => () => validatePlan(p, { pageSource: 'sandbox' });
    expect(v(one({ action: 'click' }))).toThrow(/click needs a selector/);
    expect(v(one({ action: 'fill', selector: 'x' }))).toThrow(/fill needs a string value/);
    expect(v(one({ action: 'press' }))).toThrow(/press needs a key/);
    expect(v(one({ action: 'waitFor', selector: 'x', state: 'attached' }))).toThrow(/visible or hidden/);
    expect(v(one({ action: 'waitMs' }))).toThrow(/ms >= 0/);
    expect(v(one({ action: 'click', selector: 'x', commit: 'yes' }))).toThrow(/commit must be/);
    expect(v([{ route: '/x', states: [{ key: 'Bad Key', steps: [{ action: 'waitMs', ms: 1 }] }] }])).toThrow(/key must be/);
    expect(v([{ route: '/x', states: [{ key: 'a', steps: [] }] }])).toThrow(/non-empty/);
    expect(v([{ route: '/x', states: [{ key: 'a', steps: [{ action: 'waitMs', ms: 1 }] }, { key: 'a', steps: [{ action: 'waitMs', ms: 1 }] }] }])).toThrow(/listed twice/);
    expect(v([{ route: '/x' }, { route: '/x' }])).toThrow(/listed twice/);
    expect(v([{ route: 'x' }])).toThrow(/starting with \//);
    expect(v([])).toThrow(/no routes/);
    expect(v({ route: '/x' })).toThrow(/JSON array/);
  });

  it('caps waitMs and timeoutMs', () => {
    const [r] = validatePlan([{ route: '/x', states: [{ key: 'a', steps: [{ action: 'waitMs', ms: 60_000 }, { action: 'click', selector: 'x', timeoutMs: 999_999 }] }] }], { pageSource: 'sandbox' });
    expect(r.states[0].steps[0].ms).toBe(WAIT_MS_CAP);
    expect(r.states[0].steps[1].timeoutMs).toBe(30_000);
  });
});

describe('the committed sample plan (scripts/qa/plans/task-force-start.json)', () => {
  const text = readFileSync(join(import.meta.dir, 'plans', 'task-force-start.json'), 'utf8');
  it('opens the Force-start dialog on the sandbox, and stops before its confirm', () => {
    const [r] = parsePlan(text, { pageSource: 'sandbox' });
    expect(r.route).toBe('/app/tasks/:id');
    expect(r.states.map((s) => s.key)).toEqual(['force-start-dialog']);
    // Never a click on the dialog's own Force start button.
    expect(r.states[0].steps.filter((s) => s.action === 'click' && /force start/i.test(s.selector ?? ''))).toEqual([]);
  });
  it('is refused on a preview: opening the dialog sends a Start request', () => {
    expect(() => parsePlan(text, { pageSource: 'vercel-preview' })).toThrow(/state "force-start-dialog" steps\[0\]/);
  });
});

describe('parsePlan / planText', () => {
  it('reads inline JSON, else the path', () => {
    expect(planText(' [{"route":"/x"}]', () => { throw new Error('no read'); })).toBe('[{"route":"/x"}]');
    expect(planText('/tmp/plan.json', (p) => `read ${p}`)).toBe('read /tmp/plan.json');
  });
  it('names bad JSON', () => {
    expect(() => parsePlan('[{', { pageSource: 'sandbox' })).toThrow(/QA_PLAN is not valid JSON/);
  });
});

describe('isMutatingMethod', () => {
  it('lets reads through and flags writes', () => {
    for (const m of ['GET', 'get', 'HEAD', 'OPTIONS']) expect(isMutatingMethod(m)).toBe(false);
    for (const m of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(isMutatingMethod(m)).toBe(true);
  });
});

/** A page stub whose testid `missing` never resolves, the way a selector that is not there times out. */
function stubPage(log: string[]) {
  const locator = (desc: string) => {
    const act = (name: string) => async () => {
      if (desc.includes('missing')) throw new Error(`locator.${name}: Timeout 50ms exceeded.\n  waiting for ${desc}`);
      log.push(`${name} ${desc}`);
    };
    const l: any = { first: () => l, click: act('click'), hover: act('hover'), fill: act('fill'), press: act('press'), selectOption: act('select'), waitFor: act('waitFor') };
    return l;
  };
  return {
    getByTestId: (id: string) => locator(`testid ${id}`),
    getByRole: (role: string, o?: { name?: string }) => locator(`role ${role} ${o?.name ?? ''}`.trim()),
    getByText: (t: string) => locator(`text ${t}`),
    locator: (css: string) => locator(`css ${css}`),
    waitForLoadState: async () => {},
    waitForTimeout: async (ms: number) => { log.push(`wait ${ms}`); },
    keyboard: { press: async (k: string) => { log.push(`key ${k}`); } },
  } as any;
}

describe('runSteps', () => {
  it('runs steps in order and reports no failure', async () => {
    const log: string[] = [];
    const steps: Step[] = [
      { action: 'click', selector: 'role:button[name=Start Task]' },
      { action: 'waitFor', selector: 'text:Force start' },
      { action: 'press', key: 'Escape' },
      { action: 'waitMs', ms: 10 },
    ];
    expect(await runSteps(stubPage(log), steps)).toBeNull();
    expect(log).toEqual(['click role button Start Task', 'waitFor text Force start', 'key Escape', 'wait 10']);
  });

  it('stops at a missing selector and returns where, without throwing', async () => {
    const log: string[] = [];
    const seen: Array<[number, boolean]> = [];
    const failed = await runSteps(stubPage(log), [
      { action: 'click', selector: 'testid:opener', commit: true },
      { action: 'waitFor', selector: 'testid:missing-dialog' },
      { action: 'click', selector: 'testid:never-reached' },
    ], { beforeStep: (s, i) => seen.push([i, s.commit === true]) });
    expect(failed).toEqual({ index: 1, selector: 'testid:missing-dialog', error: 'locator.waitFor: Timeout 50ms exceeded.' });
    expect(log).toEqual(['click testid opener']);
    expect(seen).toEqual([[0, true], [1, false]]);
  });
});
