/**
 * The outcome spec row in the Goal criteria sheet, mounted (happy-dom): waived
 * and stale requirements never read as passed, a read-only viewer gets no
 * decision controls, and waiving or removing go through `outcomeSpec`, never
 * a bare goalCriteria write.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { GoalCriterion, GoalCriteriaState, LivingSpecGoalCriterion } from '@buildd/shared';
import { criterionFingerprint } from '@buildd/core/mission-helpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} }),
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionGoalCriteria } = await import('./MissionGoalCriteria');

const SPEC: LivingSpecGoalCriterion = {
  type: 'living_spec',
  specId: '00000000-0000-4000-8000-000000000001',
  specRevisionId: '00000000-0000-4000-8000-000000000002',
  revision: 7,
  contentHash: 'h',
  label: 'Spec "Mission progress" revision 7',
  waived: [{ criterionId: 'R-3', reason: 'not part of this mission', by: 'user:x', at: '2026-10-14T00:00:00Z' }],
};
const COMMAND: GoalCriterion = { type: 'command', command: 'bun run test', label: 'Unit tests pass' };

function state(): GoalCriteriaState {
  return {
    evaluatedAt: '2026-10-14T00:00:00Z', evaluatedBy: 'auto', overall: 'UNVERIFIED',
    criteria: [
      { index: 0, type: 'command', verdict: 'pass', fingerprint: criterionFingerprint(COMMAND) },
      {
        index: 1, type: 'living_spec', verdict: 'UNVERIFIED', fingerprint: criterionFingerprint(SPEC),
        evidence: 'evaluator sentence that the row must not repeat',
        spec: {
          specId: SPEC.specId, revision: 7, targetSha: 'abc1234def',
          standings: [
            { criterionId: 'R-1', standing: 'pass', headSha: 'abc1234def' },
            { criterionId: 'R-2', standing: 'stale', headSha: 'old1234' },
            { criterionId: 'R-3', standing: 'pass', headSha: 'abc1234def' },
            { criterionId: 'AC-1', standing: 'missing', headSha: null },
          ],
        },
      },
    ],
  };
}

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
    return new Response(JSON.stringify({}), { status: 200, headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  globalThis.fetch = realFetch;
});

function render(readonly = false) {
  act(() => {
    root.render(createElement(MissionGoalCriteria, { missionId: 'm1', criteria: [COMMAND, SPEC], criteriaState: state(), autoVerify: true, readonly }));
  });
}
const specRow = () => [...container.querySelectorAll('[data-testid="criterion-row"]')][1] as HTMLElement;
const expand = () => act(() => { specRow().click(); });
const setInput = (el: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
  setter.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

describe('outcome spec row', () => {
  it('counts only real passes: a waived and a stale requirement are not passed', () => {
    render();
    const summary = container.querySelector('[data-testid="outcome-spec-summary"]')!.textContent!;
    expect(summary).toContain('Revision 7');
    expect(summary).toContain('One of four pass on abc1234.');
    expand();
    const open = container.querySelector('[data-testid="outcome-spec-open"]')!.textContent!;
    expect(open).toContain('Out of date');
    expect(open).toContain('R-2');
    expect(open).toContain('Not checked');
    expect(container.querySelector('[data-testid="outcome-spec-waived"]')!.textContent).toContain('R-3 waived: not part of this mission');
    expect(container.querySelector('[data-testid="unwaive-R-3"]')!.textContent).toBe('Unwaive');
  });

  it('says each fact once: the evaluator sentence is not repeated under the summary', () => {
    render();
    expect(specRow().textContent).not.toContain('evaluator sentence');
  });

  it('a read-only viewer gets no waive, remove or plain remove control', () => {
    render(true);
    expand();
    expect(container.querySelector('[data-testid^="waive-"]')).toBeNull();
    expect(container.querySelector('[data-testid="outcome-spec-remove"]')).toBeNull();
    expect(specRow().querySelector('[aria-label="Remove criterion"]')).toBeNull();
  });

  it('waives with a reason through outcomeSpec', async () => {
    render();
    expand();
    act(() => { (container.querySelector('[data-testid="waive-R-2"]') as HTMLButtonElement).click(); });
    const input = container.querySelector('[data-testid="outcome-spec-reason"] input') as HTMLInputElement;
    act(() => setInput(input, 'covered by the earlier mission'));
    await act(async () => { (container.querySelector('[data-testid="outcome-spec-reason"]') as HTMLFormElement).requestSubmit(); });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ url: '/api/missions/m1', method: 'PATCH', body: { outcomeSpec: { specId: SPEC.specId, waive: [{ criterionId: 'R-2', reason: 'covered by the earlier mission' }] } } });
  });

  it('removes only with a reason, through outcomeSpec, never a goalCriteria write', async () => {
    render();
    expand();
    expect(specRow().querySelector('[aria-label="Remove criterion"]')).toBeNull();
    act(() => { (container.querySelector('[data-testid="outcome-spec-remove"]') as HTMLButtonElement).click(); });
    const submit = container.querySelector('[data-testid="outcome-spec-reason"] button[type="submit"]') as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    const input = container.querySelector('[data-testid="outcome-spec-reason"] input') as HTMLInputElement;
    act(() => setInput(input, 'the mission was rescoped by the owner'));
    await act(async () => { (container.querySelector('[data-testid="outcome-spec-reason"]') as HTMLFormElement).requestSubmit(); });
    expect(calls.map(c => Object.keys(c.body ?? {}))).toEqual([['outcomeSpec']]);
    expect(calls[0].body.outcomeSpec).toEqual({ remove: true, specId: SPEC.specId, reason: 'the mission was rescoped by the owner' });
  });
});
