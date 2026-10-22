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
const { default: MissionGoalCriteria } = await import('./MissionGoalCriteria');

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
  it('replaces "Run verification" with the reason, pointing at selecting a spec, in plain words', () => {
    render({ criteria: [PROSE] });
    expect(q('run-verification')).toBeNull();
    const banner = q('criteria-needs-check');
    expect(banner?.textContent).toContain('Can’t verify automatically yet.');
    expect(banner?.textContent).toContain('Select the spec this mission delivers');
  });

  it('shows no raw criterion type names anywhere in the default view', () => {
    render({ criteria: [PROSE] });
    const text = container.textContent ?? '';
    for (const raw of MECHANICAL_CRITERION_TYPES) expect(text).not.toContain(raw);
    expect(text).not.toContain('goalCriteria');
  });
});

// Living Specs D-44: hand-written criteria are retired. The legacy panel shows
// a mission's stored criteria but offers no way to add, edit or remove one.
describe('MissionGoalCriteria — no hand-written criteria offered', () => {
  it('renders no add, remove or fix control, and writes nothing', async () => {
    render({ criteria: [PROSE, { type: 'all_prs_merged' }] });
    expect(container.querySelector('[aria-label="Remove criterion"]')).toBeNull();
    expect(container.querySelector('[data-testid="criteria-fix-action"]')).toBeNull();
    expect(container.querySelector('form')).toBeNull();
    expect(container.textContent).not.toContain('Add criterion');
    expect(calls.some(c => c.method === 'PATCH')).toBe(false);
  });

  it('says what decides done when the mission has no criteria', () => {
    render({ criteria: [] });
    expect(container.textContent).toContain('The spec this mission delivers decides when it is done.');
    expect(container.textContent).not.toContain('Add one');
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
});

describe('the sheet agrees with the pill (Mission checks I-3, AC-3, AC-8; visual review round 4)', () => {
  const OPEN: GoalCriterion = { type: 'no_open_tasks' };
  const PRS: GoalCriterion = { type: 'all_prs_merged' };
  const stalePass: GoalCriteriaState = {
    evaluatedAt: '2026-10-14T00:00:00Z', evaluatedBy: 'auto', overall: 'pass',
    criteria: [
      { index: 0, label: 'All PRs merged', verdict: 'pass', type: 'all_prs_merged', fingerprint: criterionFingerprint(PRS) },
      { index: 1, label: 'No open tasks', verdict: 'pass', type: 'no_open_tasks', fingerprint: criterionFingerprint(OPEN) },
    ],
  } as GoalCriteriaState;
  const badges = () => Array.from(container.querySelectorAll('[data-testid="criterion-row"] > span:first-child')).map(b => b.textContent);

  it('with a hold, the header names it and never says PASS; each row reads its live state', () => {
    render({ criteria: [PRS, OPEN], criteriaState: stalePass, hold: 'open tasks not met', liveStates: ['pass', 'partial'] });
    expect(q('criteria-hold')?.textContent).toBe('Open tasks not met.');
    expect(q('criteria-overall')?.textContent).not.toContain('Pass');
    expect(badges()).toEqual(['✓', '?']);
  });

  it('a live fail reads fail; without a hold or live states the stored verdicts stand', () => {
    render({ criteria: [PRS, OPEN], criteriaState: stalePass, liveStates: ['fail', 'pass'] });
    expect(badges()).toEqual(['✗', '✓']);
    render({ criteria: [PRS, OPEN], criteriaState: stalePass });
    expect(q('criteria-hold')).toBeNull();
    expect(q('criteria-overall')?.textContent).toContain('Pass');
    expect(badges()).toEqual(['✓', '✓']);
  });
});
