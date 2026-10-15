/**
 * Mission scope amendments, the pure half (task f3bda4e1 scenarios 5–7).
 */
import { describe, expect, it } from 'bun:test';
import { decideAt } from './decide';
import { MISSION_SCOPE_POINT, criteriaWeakening, planScope, type ScopeInput } from './scope-amendments';

const mission = {
  description: 'Ship the checkout redesign.',
  goalCriteria: [
    { type: 'command', command: 'bun run test', label: 'tests pass' },
    { type: 'all_prs_merged' },
  ],
  scopeVersion: 1,
};
const task = { id: 't-9', title: 'Add Apple Pay to checkout' };
const input = (o: Partial<ScopeInput> = {}): ScopeInput => ({
  taskId: 't-9', missionTitle: 'Checkout', missionDescription: mission.description, criteria: ['tests pass', 'all PRs merged'],
  taskTitle: task.title, taskDescription: '', deliveriesMerged: 1, proposed: false, ...o,
});

describe('the mission_scope decision point', () => {
  it('no decider, an error or a timeout: a task is a decomposition, recorded with why (no nagging)', async () => {
    const none = await decideAt(MISSION_SCOPE_POINT, input());
    expect(none.fact).toMatchObject({ verdict: 'in_scope', source: 'default', fallback: 'no_decider', reason: 'default_decomposition' });
    const failing = await decideAt(MISSION_SCOPE_POINT, input(), { decide: { id: 'd', decide: async () => { throw new Error('boom'); } } });
    expect(failing.fact).toMatchObject({ verdict: 'in_scope', fallback: 'error' });
  });

  it('a filer that proposed an amendment gets one by default; a low-confidence answer is not taken', async () => {
    const proposed = await decideAt(MISSION_SCOPE_POINT, input({ proposed: true }));
    expect(proposed.fact).toMatchObject({ verdict: 'amend_scope', reason: 'filer_proposed' });
    const unsure = await decideAt(MISSION_SCOPE_POINT, input(), { decide: { id: 'd', decide: async () => ({ verdict: 'amend_scope', confidence: 0.4, reason: 'maybe' }) } });
    expect(unsure.fact).toMatchObject({ verdict: 'in_scope', fallback: 'low_confidence' });
  });
});

describe('scenario 5: a task that fits the scope', () => {
  it('is recorded, with no description churn and nothing held', () => {
    const plan = planScope({ verdict: 'in_scope', reason: 'decomposition', mission, task });
    expect(plan).toMatchObject({ decision: 'in_scope', status: 'recorded', after: null, scopeVersionAfter: null });
  });
});

describe('scenario 6: a task that changes the intended outcome', () => {
  it('without a proposal: the description gains one scope line and the version moves', () => {
    const plan = planScope({ verdict: 'amend_scope', reason: 'new payment method', mission, task });
    expect(plan.status).toBe('applied');
    expect(plan.scopeVersionAfter).toBe(2);
    expect(plan.after?.description).toBe('Ship the checkout redesign.\n\nScope update (version 2): Add Apple Pay to checkout.');
    expect(plan.after?.goalCriteria).toEqual(mission.goalCriteria);
    expect(plan.before.description).toBe(mission.description);
  });

  it('a proposal that adds a criterion is applied as proposed', () => {
    const goalCriteria = [...mission.goalCriteria, { type: 'artifact_exists', key: 'apple-pay-runbook', label: 'runbook' }];
    const plan = planScope({ verdict: 'amend_scope', reason: 'r', mission, task, proposal: { goalCriteria } });
    expect(plan).toMatchObject({ status: 'applied', weakens: [] });
    expect(plan.after?.goalCriteria).toEqual(goalCriteria);
  });
});

describe('scenario 7: an amendment that would weaken a safety criterion', () => {
  it.each([
    ['removes it', [{ type: 'all_prs_merged' }], 'removed'],
    ['changes its command', [{ type: 'command', command: 'true', label: 'tests pass' }, { type: 'all_prs_merged' }], 'command_changed'],
    ['turns it into prose', [{ type: 'description', description: 'tests look fine', label: 'tests pass' }, { type: 'all_prs_merged' }], 'made_prose'],
    ['clears the list', [], 'cleared'],
  ] as const)('%s: held for a person, whatever the decider said', (_l, goalCriteria, how) => {
    const plan = planScope({ verdict: 'amend_scope', reason: 'r', mission, task, proposal: { goalCriteria: goalCriteria as never } });
    expect(plan.status).toBe('held');
    expect(plan.scopeVersionAfter).toBeNull();
    expect(plan.weakens.map((w) => w.how)).toContain(how);
    expect(plan.reason).toContain('tests pass');
  });

  it('an ASK is held too, and an unknown verdict reads as ASK', () => {
    expect(planScope({ verdict: 'ask', reason: 'unclear', mission, task }).status).toBe('held');
    expect(planScope({ verdict: 'whatever', reason: 'x', mission, task }).decision).toBe('ask');
  });
});

describe('criteriaWeakening', () => {
  it('adding criteria or rewording prose never weakens; leaving the list alone never does', () => {
    expect(criteriaWeakening(mission.goalCriteria, undefined)).toEqual([]);
    expect(criteriaWeakening([{ type: 'description', description: 'a', label: 'x' }], [{ type: 'description', description: 'b', label: 'x' }])).toEqual([]);
    expect(criteriaWeakening(mission.goalCriteria, [...mission.goalCriteria, { type: 'no_open_tasks' }])).toEqual([]);
    expect(criteriaWeakening(null, [])).toEqual([]);
  });
});
