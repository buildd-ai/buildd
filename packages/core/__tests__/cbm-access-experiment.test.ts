import { describe, it, expect } from 'bun:test';
import {
  CBM_WITHHELD_ARM,
  DEFAULT_CBM_ELIGIBLE_KINDS,
  cbmPriorLookupIds,
  decideCbmArm,
  isCbmEligible,
  parseCbmAccessConfig,
  type CbmEligibilityInput,
} from '../cbm-access-experiment';

/**
 * The CBM-access experiment's pure half: who is eligible, what arm a task
 * draws, and that a retry never redraws. Regression context: the only CBM
 * control before this was a role nobody was routed to, so no task was ever
 * withheld (platform audit D15).
 */

// v4-shaped ids: FNV-1a needs high-entropy keys (see experiment-randomizer.ts).
function uuid(i: number): string {
  const h = (n: number) => ((n * 2654435761) >>> 0).toString(16).padStart(8, '0');
  return `${h(i)}-${h(i + 7).slice(0, 4)}-4${h(i + 13).slice(0, 3)}-8${h(i + 29).slice(0, 3)}-${h(i + 31)}${h(i + 37).slice(0, 4)}`;
}

const CONFIG = parseCbmAccessConfig({});
const EXP = { id: '7d0c3a52-1b1e-4c6a-9d51-0000000000c8', policyVersion: 1, treatmentFraction: 0.2 };

const eligibleInput = (over: Partial<CbmEligibilityInput> = {}): CbmEligibilityInput => ({
  backend: 'claude', runnerCanWithhold: true, hasRepo: true, roleCbmDisabled: false,
  taskClass: 'work', kind: 'engineering', category: 'feature', reviewerFor: undefined, ...over,
});

function drawFor(taskId: string, over: { treatmentFraction?: unknown; priors?: any[]; task?: Record<string, unknown> } = {}) {
  return decideCbmArm({
    experiment: { ...EXP, ...(over.treatmentFraction !== undefined ? { treatmentFraction: over.treatmentFraction } : {}) },
    task: { id: taskId, taskClass: 'work', ...(over.task ?? {}) },
    priors: over.priors ?? [],
    eligibility: () => isCbmEligible(eligibleInput(), CONFIG),
  });
}

describe('cbm_access enrolment', () => {
  it('withholds CBM from roughly the configured share of eligible tasks', () => {
    const N = 4000;
    let withheld = 0;
    for (let i = 0; i < N; i++) {
      const d = drawFor(uuid(i));
      if (d.source === 'ineligible') throw new Error('eligible task judged ineligible');
      expect(d.source).toBe('drawn');
      if (d.arm === CBM_WITHHELD_ARM) {
        withheld++;
        expect(d.propensity).toBeCloseTo(0.2, 10);
      } else {
        expect(d.propensity).toBeCloseTo(0.8, 10);
      }
    }
    // 0.2 +/- ~5 standard errors at N=4000.
    expect(withheld / N).toBeGreaterThan(0.17);
    expect(withheld / N).toBeLessThan(0.23);
  });

  it('enrols nobody into the withheld arm at an out-of-range or zero fraction', () => {
    for (const f of [0, 20, -1, 'x']) {
      for (let i = 0; i < 200; i++) {
        const d = drawFor(uuid(i), { treatmentFraction: f });
        expect(d.source === 'drawn' && d.arm).toBe('control');
      }
    }
  });

  it('draws the same arm for the same task every time (per unit, not per attempt)', () => {
    for (let i = 0; i < 200; i++) {
      const a = drawFor(uuid(i));
      const b = drawFor(uuid(i));
      expect(b).toEqual(a);
    }
  });
});

describe('cbm_access retries keep their arm', () => {
  const PARENT = uuid(1);
  const CHILD = uuid(2);

  it('a re-claimed task reuses its own row and is not re-judged', () => {
    const d = decideCbmArm({
      experiment: EXP,
      task: { id: PARENT, taskClass: 'work' },
      priors: [{ taskId: PARENT, unitId: PARENT, arm: 'treatment', propensity: 0.2 }],
      // Even if the task would now be ineligible, its arm stands.
      eligibility: () => ({ eligible: false, reason: 'kind_not_graph_relevant' }),
    });
    expect(d).toMatchObject({ source: 'existing', arm: 'treatment', propensity: 0.2 });
  });

  it('a CI-retry attempt inherits its parent arm instead of drawing', () => {
    // Pick a parent that drew control and a fraction under which the child's
    // own id would have drawn treatment: inheritance must win over the draw.
    const d = decideCbmArm({
      experiment: { ...EXP, treatmentFraction: 0.99 },
      task: { id: CHILD, parentTaskId: PARENT, taskClass: 'attempt' },
      priors: [{ taskId: PARENT, unitId: PARENT, arm: 'control', propensity: 0.8 }],
      eligibility: () => ({ eligible: false, reason: 'task_class_not_work' }),
    });
    expect(d).toMatchObject({ source: 'inherited', arm: 'control', propensity: 0.8, unitId: PARENT, inheritedFromTaskId: PARENT });
  });

  it('an attempt whose parent was never enrolled does not draw on its own', () => {
    const d = decideCbmArm({
      experiment: EXP,
      task: { id: CHILD, parentTaskId: PARENT, taskClass: 'attempt' },
      priors: [],
      eligibility: () => isCbmEligible(eligibleInput({ taskClass: 'attempt' }), CONFIG),
    });
    expect(d).toEqual({ source: 'ineligible', reason: 'task_class_not_work' });
  });

  it('looks up the parent row only for attempt lineage', () => {
    expect(cbmPriorLookupIds({ id: CHILD, parentTaskId: PARENT, taskClass: 'attempt' })).toEqual([CHILD, PARENT]);
    // parentTaskId on a work task is the creator, not retry lineage.
    expect(cbmPriorLookupIds({ id: CHILD, parentTaskId: PARENT, taskClass: 'work' })).toEqual([CHILD]);
  });
});

describe('cbm_access eligibility', () => {
  it('admits a Claude engineering work task in a repo-backed workspace', () => {
    expect(isCbmEligible(eligibleInput(), CONFIG)).toEqual({ eligible: true, reason: null });
  });

  it('excludes Codex — a different backend and a different CBM delivery path', () => {
    expect(isCbmEligible(eligibleInput({ backend: 'codex' }), CONFIG).reason).toBe('backend_not_claude');
  });

  it('excludes tasks claimed by a runner that cannot honour the withheld marker', () => {
    // An old runner would ignore the marker and mount CBM while the row said
    // "withheld" — contamination recorded as clean data.
    expect(isCbmEligible(eligibleInput({ runnerCanWithhold: false }), CONFIG).reason).toBe('runner_cannot_withhold');
  });

  it('excludes kinds with no structural question to ask the graph', () => {
    for (const kind of ['coordination', 'writing', 'design', 'observation']) {
      expect(isCbmEligible(eligibleInput({ kind }), CONFIG).reason).toBe('kind_not_graph_relevant');
    }
    for (const kind of DEFAULT_CBM_ELIGIBLE_KINDS) {
      expect(isCbmEligible(eligibleInput({ kind }), CONFIG).eligible).toBe(true);
    }
  });

  it('excludes unkinded tasks unless the config opts them in', () => {
    expect(isCbmEligible(eligibleInput({ kind: null }), CONFIG).reason).toBe('kind_unstated');
    expect(isCbmEligible(eligibleInput({ kind: null }), parseCbmAccessConfig({ eligibility: { includeUnkinded: true } })).eligible).toBe(true);
  });

  it('excludes reviewers, bookkeeping, repo-less workspaces and roles that already opt out', () => {
    expect(isCbmEligible(eligibleInput({ category: 'review' }), CONFIG).reason).toBe('reviewer_task');
    expect(isCbmEligible(eligibleInput({ reviewerFor: 'task-x' }), CONFIG).reason).toBe('reviewer_task');
    expect(isCbmEligible(eligibleInput({ taskClass: 'bookkeeping' }), CONFIG).reason).toBe('task_class_not_work');
    expect(isCbmEligible(eligibleInput({ hasRepo: false }), CONFIG).reason).toBe('no_repo');
    expect(isCbmEligible(eligibleInput({ roleCbmDisabled: true }), CONFIG).reason).toBe('role_cbm_disabled');
  });

  it('takes the kind list from config, and falls back on a malformed one', () => {
    const cfg = parseCbmAccessConfig({ eligibility: { kinds: ['engineering'] } });
    expect(isCbmEligible(eligibleInput({ kind: 'research' }), cfg).reason).toBe('kind_not_graph_relevant');
    expect(parseCbmAccessConfig({ eligibility: { kinds: 'engineering' } }).kinds).toEqual(DEFAULT_CBM_ELIGIBLE_KINDS);
    expect(parseCbmAccessConfig({ eligibility: { kinds: [] } }).kinds).toEqual(DEFAULT_CBM_ELIGIBLE_KINDS);
  });
});
