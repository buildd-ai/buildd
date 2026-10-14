/**
 * The outcome spec picker in the mission settings, mounted (happy-dom): it
 * writes through `outcomeSpec` only, a narrowed scope needs its reason, and a
 * read-only viewer gets no picker.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { LivingSpecGoalCriterion } from '@buildd/shared';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} }),
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: OutcomeSpecPicker, outcomeSpecBody, specOptionDescription } = await import('./OutcomeSpecPicker');

const SPEC_ID = '00000000-0000-4000-8000-000000000001';
const SELECTED: LivingSpecGoalCriterion = {
  type: 'living_spec', specId: SPEC_ID, specRevisionId: '00000000-0000-4000-8000-000000000002', revision: 4, contentHash: 'h',
  provisional: true, label: 'Spec "Mission progress" revision 4',
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; method: string; body: any }>;
const realFetch = globalThis.fetch;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  calls = [];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null });
    const payload = String(url).startsWith('/api/specs')
      ? { specs: [{ id: SPEC_ID, title: 'Mission progress', status: 'approved', headRevision: 7, approvedRevision: 6 }] }
      : {};
    return new Response(JSON.stringify(payload), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

function render(selected: LivingSpecGoalCriterion[], readonly = false) {
  act(() => { root.render(createElement(OutcomeSpecPicker, { missionId: 'm1', workspaceId: 'w1', selected, readonly })); });
}
const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
const setInput = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('OutcomeSpecPicker', () => {
  it('a read-only viewer sees the selection but no picker', () => {
    render([SELECTED], true);
    expect(container.textContent).toContain('Mission progress');
    expect(container.textContent).toContain('proposed');
    expect(q('outcome-spec-choose')).toBeNull();
    expect(container.querySelector('button')).toBeNull();
  });

  it('changing a selection writes outcomeSpec with the revision, never goalCriteria', async () => {
    render([SELECTED]);
    await act(async () => { (container.querySelector('li button') as HTMLButtonElement).click(); });
    expect(calls[0]).toMatchObject({ url: '/api/specs?workspaceId=w1', method: 'GET' });
    setInputAct(q('outcome-spec-revision') as HTMLInputElement, '6');
    await act(async () => { (q('outcome-spec-form') as HTMLFormElement).requestSubmit(); });
    const patch = calls.find(c => c.method === 'PATCH')!;
    expect(Object.keys(patch.body)).toEqual(['outcomeSpec']);
    expect(patch.body.outcomeSpec).toEqual({ specId: SPEC_ID, revision: 6 });
  });

  it('says when nothing is selected and offers the choice', () => {
    render([]);
    expect(container.textContent).toContain('None. The mission completes on its goal criteria alone.');
    expect(q('outcome-spec-choose')!.textContent).toBe('Choose an outcome spec');
  });
});

function setInputAct(el: HTMLInputElement, value: string) { act(() => setInput(el, value)); }

describe('changing an existing selection', () => {
  const WAIVED: LivingSpecGoalCriterion = {
    ...SELECTED,
    criteria: ['R-1', 'R-2'],
    narrowedReason: 'only the build half applies',
    waived: [
      { criterionId: 'R-1', reason: 'covered by the earlier mission', by: 'user:x', at: '2026-10-14T00:00:00Z' },
      { criterionId: 'R-2', reason: 'out of reach for this mission', by: 'user:x', at: '2026-10-14T00:00:00Z' },
    ],
  };
  const openChange = async () => { await act(async () => { (container.querySelector('li button') as HTMLButtonElement).click(); }); };
  const submit = async () => { await act(async () => { (q('outcome-spec-form') as HTMLFormElement).requestSubmit(); }); };
  const patch = () => calls.find(c => c.method === 'PATCH')!.body.outcomeSpec;

  it('saving with no edits sends no revision, so the waivers stay', async () => {
    render([WAIVED]);
    await openChange();
    expect(q('outcome-spec-repin-warning')).toBeNull();
    await submit();
    expect(patch().revision).toBeUndefined();
    expect(patch().specId).toBe(SPEC_ID);
  });

  it('a different revision is sent, and the form says the waivers will be cleared first', async () => {
    render([WAIVED]);
    await openChange();
    setInputAct(q('outcome-spec-revision') as HTMLInputElement, '6');
    expect(q('outcome-spec-repin-warning')!.textContent).toBe('Revision 6 clears the two waivers on this spec.');
    await submit();
    expect(patch().revision).toBe(6);
  });

  it('unticking "Only some of its requirements" clears the narrowed scope', async () => {
    render([WAIVED]);
    await openChange();
    await act(async () => { (q('outcome-spec-narrow') as HTMLInputElement).click(); });
    await submit();
    expect(patch()).toHaveProperty('criteria', null);
    expect(patch().narrowedReason).toBeUndefined();
  });
});

describe('a workspace with no specs', () => {
  beforeEach(() => {
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), method: init?.method ?? 'GET', body: null });
      return new Response(JSON.stringify({ specs: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }) as typeof fetch;
  });

  it('says there is nothing to choose and links to the specs page instead of opening the form', async () => {
    render([]);
    await act(async () => { (q('outcome-spec-choose') as HTMLButtonElement).click(); });
    expect(q('outcome-spec-form')).toBeNull();
    const empty = q('outcome-spec-empty');
    expect(empty?.textContent).toContain('This workspace has no specs to choose from.');
    expect(empty?.querySelector('a')?.getAttribute('href')).toBe('/app/specs');
    expect(container.textContent).not.toContain('completes only when');
  });

  it('with no outcome spec, says what choosing one would do without contradicting itself', () => {
    render([]);
    expect(container.textContent).toContain('None. The mission completes on its goal criteria alone.');
    expect(container.textContent).not.toContain('The mission completes only when');
  });
});

describe('outcomeSpecBody', () => {
  it('leaves the revision to the server when blank', () => {
    expect(outcomeSpecBody({ specId: SPEC_ID, revision: '', narrow: false, criteria: '', reason: '' })).toEqual({ specId: SPEC_ID });
  });
  it('a narrowed scope needs ids and a reason of ten characters or more', () => {
    expect(outcomeSpecBody({ specId: SPEC_ID, revision: '', narrow: true, criteria: 'R-1, AC-2', reason: 'short' })).toBeNull();
    expect(outcomeSpecBody({ specId: SPEC_ID, revision: '', narrow: true, criteria: '', reason: 'long enough reason' })).toBeNull();
    expect(outcomeSpecBody({ specId: SPEC_ID, revision: '7', narrow: true, criteria: 'R-1, AC-2', reason: 'only the build half' }))
      .toEqual({ specId: SPEC_ID, revision: 7, criteria: ['R-1', 'AC-2'], narrowedReason: 'only the build half' });
  });
  it('refuses a revision that is not a whole number', () => {
    expect(outcomeSpecBody({ specId: SPEC_ID, revision: 'two', narrow: false, criteria: '', reason: '' })).toBeNull();
    expect(outcomeSpecBody({ specId: '', revision: '', narrow: false, criteria: '', reason: '' })).toBeNull();
  });
});

describe('specOptionDescription', () => {
  it('names the revision a choice pins', () => {
    expect(specOptionDescription({ id: 'a', title: 't', status: 'approved', headRevision: 7, approvedRevision: 6 })).toBe('Revision 6 approved, revision 7 proposed');
    expect(specOptionDescription({ id: 'a', title: 't', status: 'draft', headRevision: 2, approvedRevision: null })).toBe('Revision 2, proposed');
  });
});
