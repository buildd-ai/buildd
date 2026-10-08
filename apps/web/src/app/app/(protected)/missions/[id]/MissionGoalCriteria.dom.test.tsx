/**
 * MissionGoalCriteria mounted (happy-dom): the Goal criteria sheet's
 * non-verifiable state, its preflighted CTA, and one-source-of-truth rows.
 */
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/app/missions/m1' });

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { GoalCriterion, GoalCriteriaState } from '@buildd/shared';
import { criterionFingerprint, MECHANICAL_CRITERION_TYPES } from '@buildd/core/mission-helpers';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

mock.module('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {}, back: () => {}, prefetch: () => {} }),
}));

const { act, createElement } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: MissionGoalCriteria, AddCriterionForm } = await import('./MissionGoalCriteria');

const PROSE: GoalCriterion = {
  type: 'description',
  description: 'The quality loop reads well to a person',
  notMechanizableReason: 'Taste is not scriptable here',
};

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let calls: Array<{ url: string; method: string; body: unknown }>;
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

function render(props: Partial<Parameters<typeof MissionGoalCriteria>[0]> & { criteria: GoalCriterion[] }) {
  act(() => {
    root.render(createElement(MissionGoalCriteria, {
      missionId: 'm1',
      criteriaState: null,
      autoVerify: true,
      ...props,
    }));
  });
}

const q = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;

describe('MissionGoalCriteria — no automatic check bound', () => {
  it('replaces "Run verification" with the corrective action, in plain words', () => {
    render({ criteria: [PROSE], missionPrCount: 0 });
    expect(q('run-verification')).toBeNull();
    const banner = q('criteria-needs-check');
    expect(banner?.textContent).toContain('Can’t verify automatically yet.');
    expect(q('criteria-fix-action')?.textContent).toBe('Add check');
  });

  it('shows no raw criterion type names anywhere in the default view', () => {
    render({ criteria: [PROSE], missionPrCount: 2 });
    const text = container.textContent ?? '';
    for (const raw of MECHANICAL_CRITERION_TYPES) expect(text).not.toContain(raw);
    expect(text).not.toContain('goalCriteria');
  });

  it('adds the PR check in one tap when the mission already has PRs, and never calls evaluate', async () => {
    render({ criteria: [PROSE], missionPrCount: 2 });
    const action = q('criteria-fix-action')!;
    expect(action.textContent).toBe('Check that every PR merged');
    await act(async () => { action.click(); });
    expect(calls.some(c => c.url.endsWith('/evaluate'))).toBe(false);
    const patch = calls.find(c => c.method === 'PATCH');
    expect(patch?.body).toEqual({ goalCriteria: [PROSE, { type: 'all_prs_merged' }] });
  });

  it('opens the add form when there is nothing to infer from', async () => {
    render({ criteria: [PROSE], missionPrCount: 0 });
    await act(async () => { q('criteria-fix-action')!.click(); });
    expect(container.querySelector('form')).not.toBeNull();
    expect(calls.length).toBe(0);
  });
});

describe('MissionGoalCriteria — automatic check bound', () => {
  it('offers "Run verification" and no corrective banner', () => {
    render({ criteria: [{ type: 'all_prs_merged' }, PROSE] });
    expect(q('run-verification')).not.toBeNull();
    expect(q('criteria-needs-check')).toBeNull();
  });

  it('sets AI-judged criteria apart from automatic checks', () => {
    render({ criteria: [PROSE, { type: 'all_prs_merged' }] });
    const rows = [...container.querySelectorAll('[data-testid="criterion-row"]')].map(r => r.getAttribute('data-check'));
    expect(rows).toEqual(['automatic', 'judged']);
    expect(container.textContent).toContain('Checked automatically');
    expect(container.textContent).toContain('Judged by AI');
  });

  it('does not show a stored verdict under a criterion it was not produced for', () => {
    // The observed contradiction: "PR #101 merged" over "No PRs found for this mission yet".
    const evaluated: GoalCriterion = { type: 'all_prs_merged' };
    const state: GoalCriteriaState = {
      evaluatedAt: new Date().toISOString(),
      evaluatedBy: 'auto',
      overall: 'UNVERIFIED',
      criteria: [{
        index: 0, type: 'all_prs_merged', verdict: 'UNVERIFIED',
        evidence: 'No PRs found for this mission yet', fingerprint: criterionFingerprint(evaluated),
      }],
    };
    render({ criteria: [{ type: 'all_prs_merged', label: 'PR #101 merged' }], criteriaState: state });
    expect(container.textContent).toContain('PR #101 merged');
    expect(container.textContent).not.toContain('No PRs found');
    expect(q('criterion-not-checked')).not.toBeNull();
  });

  it('accepts a written goal added beside an existing automatic check', async () => {
    // Regression: the form validated the new row alone, so a written goal was
    // always refused for lacking an automatic check — even beside one.
    const added: GoalCriterion[] = [];
    act(() => {
      root.render(createElement(AddCriterionForm, {
        initial: PROSE, siblings: [{ type: 'all_prs_merged' }], onAdd: c => added.push(c), onCancel: () => {},
      }));
    });
    await act(async () => { container.querySelector('form')!.requestSubmit(); });
    expect(q('criterion-error')).toBeNull();
    expect(added).toEqual([PROSE]);
  });

  it('refuses a written goal with nothing automatic beside it, in plain words with details folded away', async () => {
    const added: GoalCriterion[] = [];
    act(() => {
      root.render(createElement(AddCriterionForm, { initial: PROSE, siblings: [], onAdd: c => added.push(c), onCancel: () => {} }));
    });
    await act(async () => { container.querySelector('form')!.requestSubmit(); });
    expect(added).toEqual([]);
    const err = q('criterion-error')!;
    const visible = err.querySelector('p')!.textContent ?? '';
    for (const raw of MECHANICAL_CRITERION_TYPES) expect(visible).not.toContain(raw);
    expect(err.querySelector('details')).not.toBeNull();
  });
});
