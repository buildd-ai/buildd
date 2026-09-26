import { describe, expect, it } from 'bun:test';
import {
  TASK_AREA_CONTROL_ARM,
  TASK_AREA_FALLBACK,
  TASK_AREA_TREATMENT_ARM,
  assignTaskAreaArm,
  pathAreaOverlap,
  pathCovers,
  readTaskAreaHint,
  renderTaskAreaBlock,
  resolveTaskAreaConfig,
  taskAreaConfigFromEnv,
  unionNeighbourPaths,
  type NeighbourTask,
  type TaskAreaConfig,
} from '../task-area-prediction';

const cfg = (over: Partial<TaskAreaConfig> = {}): TaskAreaConfig => ({ ...TASK_AREA_FALLBACK, ...over });

describe('resolveTaskAreaConfig', () => {
  it('runs on the fallback when nothing is configured', () => {
    const { config, rejected } = resolveTaskAreaConfig();
    expect(config).toEqual(TASK_AREA_FALLBACK);
    expect(rejected).toEqual([]);
  });

  it('ships measuring-but-not-changing-anything: enabled, fraction 0', () => {
    // The default has to record a prediction for every task (so the overlap
    // metric accrues from day one) while changing no task's retrieval until an
    // operator sets a fraction. A default that enrolled anybody would ship a
    // behaviour change nobody asked for.
    expect(TASK_AREA_FALLBACK.enabled).toBe(true);
    expect(TASK_AREA_FALLBACK.fraction).toBe(0);
  });

  it('applies later layers over earlier ones, so the DB row beats env', () => {
    const { config } = resolveTaskAreaConfig({ topK: '3' }, { topK: 9 });
    expect(config.topK).toBe(9);
  });

  it('accepts numeric strings, because env vars are always strings', () => {
    const { config, rejected } = resolveTaskAreaConfig({
      topK: '4', similarityFloor: '0.55', maxPaths: '20', maxPathsPerNeighbour: '2', enabled: 'false',
    });
    expect(rejected).toEqual([]);
    expect(config).toMatchObject({
      topK: 4, similarityFloor: 0.55, maxPaths: 20, maxPathsPerNeighbour: 2, enabled: false,
    });
  });

  it('rejects out-of-range knobs instead of clamping them, and names what it rejected', () => {
    const { config, rejected } = resolveTaskAreaConfig({ topK: 0, maxPaths: -1, similarityFloor: 15 });
    expect(config.topK).toBe(TASK_AREA_FALLBACK.topK);
    expect(config.maxPaths).toBe(TASK_AREA_FALLBACK.maxPaths);
    expect(config.similarityFloor).toBe(TASK_AREA_FALLBACK.similarityFloor);
    expect(rejected.map(r => r.field).sort()).toEqual(['maxPaths', 'similarityFloor', 'topK']);
    expect(rejected.find(r => r.field === 'topK')?.value).toBe('0');
  });

  it('rejects a path source that is neither diff nor manifest', () => {
    const { config, rejected } = resolveTaskAreaConfig({ pathSource: 'both' });
    expect(config.pathSource).toBe('diff');
    expect(rejected[0]?.field).toBe('pathSource');
  });

  it('passes fraction through unvalidated — the randomiser owns that rule', () => {
    // resolveEnrolmentFraction rejects out-of-range at draw time. Validating it
    // twice, in two places, is how the two rules drift apart.
    const { config, rejected } = resolveTaskAreaConfig({ fraction: 15 });
    expect(config.fraction).toBe(15);
    expect(rejected).toEqual([]);
    expect(assignTaskAreaArm('a-task-id', config).arm).toBe(TASK_AREA_CONTROL_ARM);
  });

  it('ignores an unknown key rather than rejecting it', () => {
    const { config, rejected } = resolveTaskAreaConfig({ retiredKnob: 'true' });
    expect(config).toEqual(TASK_AREA_FALLBACK);
    expect(rejected).toEqual([]);
  });

  it('treats an unset env var as no opinion, not as an override to undefined', () => {
    expect(taskAreaConfigFromEnv({})).toEqual({});
    expect(taskAreaConfigFromEnv({ BUILDD_TASK_AREA_FRACTION: '' })).toEqual({});
    expect(taskAreaConfigFromEnv({ BUILDD_TASK_AREA_FRACTION: '0.25' })).toEqual({ fraction: '0.25' });
  });
});

describe('assignTaskAreaArm', () => {
  it('is stable for a task, so a retry cannot land the other arm', () => {
    const config = cfg({ fraction: 0.5 });
    const first = assignTaskAreaArm('6f1d8a2e-0000-4000-8000-1234567890ab', config);
    const second = assignTaskAreaArm('6f1d8a2e-0000-4000-8000-1234567890ab', config);
    expect(second).toEqual(first);
  });

  it('re-randomises when the policy version moves', () => {
    const id = '6f1d8a2e-0000-4000-8000-1234567890ab';
    const a = assignTaskAreaArm(id, cfg({ fraction: 0.5, policyVersion: 'task-area-v1' }));
    const b = assignTaskAreaArm(id, cfg({ fraction: 0.5, policyVersion: 'task-area-v2' }));
    // Not an arm assertion — the point is that the version is IN the salt, so
    // the draw is a different draw. Same arm by chance is possible; the same
    // recorded policyVersion is not.
    expect(a.policyVersion).toBe('task-area-v1');
    expect(b.policyVersion).toBe('task-area-v2');
  });

  it('runs the control with no task id and records propensity 1', () => {
    const a = assignTaskAreaArm(undefined, cfg({ fraction: 0.9 }));
    expect(a.arm).toBe(TASK_AREA_CONTROL_ARM);
    expect(a.propensity).toBe(1);
  });

  it('records the propensity of the arm actually drawn', () => {
    const config = cfg({ fraction: 0.25 });
    for (const id of ['a1b2c3d4-0000-4000-8000-00000000000' + 1, 'f9e8d7c6-0000-4000-8000-00000000000' + 2]) {
      const a = assignTaskAreaArm(id, config);
      expect(a.propensity).toBeCloseTo(a.arm === TASK_AREA_TREATMENT_ARM ? 0.25 : 0.75, 10);
    }
  });

  it('enrols roughly the configured share over many tasks', () => {
    const config = cfg({ fraction: 0.5 });
    let treated = 0;
    const n = 2000;
    for (let i = 0; i < n; i++) {
      // High-entropy ids: FNV-1a degrades on keys differing only in the tail.
      const id = `${(i * 2654435761 >>> 0).toString(16)}-0000-4000-8000-${i.toString(16).padStart(12, '0')}`;
      if (assignTaskAreaArm(id, config).arm === TASK_AREA_TREATMENT_ARM) treated++;
    }
    expect(treated / n).toBeGreaterThan(0.45);
    expect(treated / n).toBeLessThan(0.55);
  });
});

describe('unionNeighbourPaths', () => {
  const n = (taskId: string, score: number, paths: string[]): NeighbourTask => ({ taskId, score, paths });

  it('orders by neighbour similarity, so the cap keeps the closest prior work', () => {
    const out = unionNeighbourPaths(
      [n('far', 0.4, ['c.ts']), n('near', 0.9, ['a.ts']), n('mid', 0.6, ['b.ts'])],
      cfg({ maxPaths: 2 }),
    );
    expect(out.paths).toEqual(['a.ts', 'b.ts']);
    expect(out.truncated).toBe(true);
    expect(out.contributors.map(c => c.taskId)).toEqual(['near', 'mid']);
  });

  it('drops a neighbour below the similarity floor entirely', () => {
    const out = unionNeighbourPaths([n('weak', 0.1, ['x.ts'])], cfg({ similarityFloor: 0.3 }));
    expect(out.paths).toEqual([]);
    expect(out.contributors).toEqual([]);
    // It was still considered — the denominator has to see it.
    expect(out.considered).toBe(1);
    expect(out.topScore).toBe(0.1);
  });

  it('caps what any one neighbour contributes', () => {
    const out = unionNeighbourPaths(
      [n('huge', 0.9, ['a.ts', 'b.ts', 'c.ts', 'd.ts']), n('other', 0.8, ['z.ts'])],
      cfg({ maxPathsPerNeighbour: 2, maxPaths: 10 }),
    );
    expect(out.paths).toEqual(['a.ts', 'b.ts', 'z.ts']);
  });

  it('de-duplicates across neighbours and normalises trailing separators', () => {
    const out = unionNeighbourPaths(
      [n('a', 0.9, ['apps/web/', 'apps/web']), n('b', 0.8, ['apps/web'])],
      cfg(),
    );
    expect(out.paths).toEqual(['apps/web']);
    expect(out.contributors.map(c => c.taskId)).toEqual(['a']);
  });

  it('does not report truncation when the cap was reached with nothing dropped', () => {
    const out = unionNeighbourPaths([n('a', 0.9, ['a.ts', 'b.ts'])], cfg({ maxPaths: 2 }));
    expect(out.paths).toHaveLength(2);
    expect(out.truncated).toBe(false);
  });

  it('returns an empty prediction, not a throw, when nothing came back', () => {
    const out = unionNeighbourPaths([], cfg());
    expect(out).toMatchObject({ paths: [], contributors: [], considered: 0, topScore: null, truncated: false });
  });
});

describe('pathCovers', () => {
  it('matches exactly, and either way round on a directory prefix', () => {
    expect(pathCovers('packages/core', 'packages/core/db/schema.ts')).toBe(true);
    expect(pathCovers('packages/core/db/schema.ts', 'packages/core')).toBe(true);
    expect(pathCovers('packages/core', 'packages/core')).toBe(true);
  });

  it('does not match a sibling that merely shares a prefix string', () => {
    expect(pathCovers('packages/core', 'packages/core-utils/x.ts')).toBe(false);
  });
});

describe('pathAreaOverlap', () => {
  it('scores recall over the actual diff and precision over the prediction', () => {
    const o = pathAreaOverlap(
      ['apps/web/a.ts', 'apps/web/b.ts', 'docs/unrelated.md'],
      ['apps/web/a.ts', 'apps/web/b.ts', 'packages/core/c.ts'],
    );
    expect(o.recall).toBeCloseTo(2 / 3, 10);
    expect(o.precision).toBeCloseTo(2 / 3, 10);
    expect(o.exactRecall).toBeCloseTo(2 / 3, 10);
    expect(o.predicted).toBe(3);
    expect(o.actual).toBe(3);
  });

  it('credits a directory prediction with covering the files under it, but not as an exact hit', () => {
    const o = pathAreaOverlap(['packages/core'], ['packages/core/db/schema.ts', 'packages/core/x.ts']);
    expect(o.recall).toBe(1);
    expect(o.exactRecall).toBe(0);
    expect(o.precision).toBe(1);
  });

  it('shows the whole-repo cheat in precision, which is why recall is never read alone', () => {
    const wide = pathAreaOverlap(
      ['apps', 'packages', 'docs', 'scripts', 'tests'],
      ['apps/web/a.ts'],
    );
    expect(wide.recall).toBe(1);
    expect(wide.precision).toBeCloseTo(1 / 5, 10);
  });

  it('marks a task with no recorded diff unscorable rather than scoring it zero', () => {
    const o = pathAreaOverlap(['apps/web/a.ts'], []);
    expect(o.unscorable).toBe(true);
    expect(o.recall).toBe(0);
  });

  it('scores an empty prediction against a real diff as a plain miss', () => {
    const o = pathAreaOverlap([], ['apps/web/a.ts']);
    expect(o.unscorable).toBe(false);
    expect(o.recall).toBe(0);
    expect(o.predicted).toBe(0);
  });

  it('survives junk in either list', () => {
    const o = pathAreaOverlap([null, 42, 'apps/web/a.ts'] as unknown[], ['apps/web/a.ts', '   ']);
    expect(o.predicted).toBe(1);
    expect(o.actual).toBe(1);
    expect(o.recall).toBe(1);
  });
});

describe('readTaskAreaHint', () => {
  const hint = {
    arm: TASK_AREA_TREATMENT_ARM,
    policyVersion: 'task-area-v1',
    paths: ['apps/web/a.ts'],
    source: 'diff',
  };

  it('reads a well-formed treatment hint', () => {
    expect(readTaskAreaHint({ predictedTaskArea: hint })).toEqual({
      arm: TASK_AREA_TREATMENT_ARM, policyVersion: 'task-area-v1', paths: ['apps/web/a.ts'], source: 'diff',
    });
  });

  it('refuses a control-arm hint, so the control cannot be scoped by accident', () => {
    expect(readTaskAreaHint({ predictedTaskArea: { ...hint, arm: TASK_AREA_CONTROL_ARM } })).toBeNull();
  });

  it('returns null for anything missing or malformed', () => {
    expect(readTaskAreaHint(undefined)).toBeNull();
    expect(readTaskAreaHint({})).toBeNull();
    expect(readTaskAreaHint({ predictedTaskArea: 'yes' })).toBeNull();
    expect(readTaskAreaHint({ predictedTaskArea: { ...hint, paths: [] } })).toBeNull();
    expect(readTaskAreaHint({ predictedTaskArea: { ...hint, paths: [1, ''] } })).toBeNull();
  });
});

describe('renderTaskAreaBlock', () => {
  it('lists the paths and says out loud that it is advisory', () => {
    const block = renderTaskAreaBlock({
      arm: TASK_AREA_TREATMENT_ARM,
      policyVersion: 'task-area-v1',
      paths: ['apps/web/a.ts', 'packages/core'],
      source: 'diff',
    });
    expect(block).toContain('apps/web/a.ts');
    expect(block).toContain('packages/core');
    expect(block).toContain('ADVISORY');
    // An agent that reads this as a scope declaration stops looking elsewhere.
    expect(block).toContain('not a declaration of scope');
    expect(block).toContain('path manifest');
  });

  it('points at the graph only when the task has it', () => {
    const hint = { arm: TASK_AREA_TREATMENT_ARM, policyVersion: 'task-area-v1', paths: ['a/b.ts'], source: 'diff' as const };
    expect(renderTaskAreaBlock(hint)).toContain('`codebase-memory`');
    // A CBM-withheld task must not be steered toward a tool it does not have.
    const withheld = renderTaskAreaBlock(hint, { cbmAvailable: false });
    expect(withheld).not.toContain('codebase-memory');
    expect(withheld).toContain('`recall`');
  });
});
