import { describe, test, expect, mock, beforeEach } from 'bun:test';

let insertShouldThrow = false;
const inserted: Array<{ row: any; target: any }> = [];
mock.module('@buildd/core/db', () => ({
  db: {
    insert: (_table: any) => ({
      values: (row: any) => ({
        onConflictDoNothing: (opts: any) => {
          if (insertShouldThrow) return Promise.reject(new Error('boom'));
          inserted.push({ row, target: opts?.target });
          return Promise.resolve();
        },
      }),
    }),
  },
}));

const { buildStagedAssignment, withStagedExperiment, recordStagedAssignment } = await import('./staged-arm');
const { resolveStagedConfig } = await import('../../../../../../runner/src/staged-self-review');

const exp = { id: 'exp-1', policyVersion: 2, treatmentFraction: 0.5 };

beforeEach(() => {
  insertShouldThrow = false;
  inserted.length = 0;
});

describe('withStagedExperiment', () => {
  test('off or unset selfReview: workspace returned untouched', () => {
    const off = { gitConfig: { selfReview: 'off' } };
    const none = { gitConfig: {} };
    expect(withStagedExperiment(off, exp)).toBe(off);
    expect(withStagedExperiment(none, exp)).toBe(none);
  });
  test('no running experiment: untouched', () => {
    const ws = { gitConfig: { selfReview: 'acting' } };
    expect(withStagedExperiment(ws, null)).toBe(ws);
  });
  test('acting attaches the experiment, with checklist pin when configured', () => {
    const out = withStagedExperiment({ gitConfig: { selfReview: 'acting' } }, { ...exp, config: { checklistVersion: 'v1' } });
    expect(out.gitConfig.selfReviewExperiment).toEqual({ id: 'exp-1', policyVersion: 2, treatmentFraction: 0.5, checklistVersion: 'v1' });
  });
  test('acting + experiment: the runner draws an arm with propensity; control sees no stage', () => {
    const ws = withStagedExperiment({ gitConfig: { selfReview: 'acting' } }, exp);
    const arms = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const r = resolveStagedConfig(ws.gitConfig, `task-${i}`);
      expect(r.mode).toBe('acting');
      expect(r.propensity).toBeCloseTo(0.5);
      arms.add(r.arm);
    }
    expect(arms).toEqual(new Set(['control', 'treatment']));
  });
  test('recording never gets a treatment arm', () => {
    const ws = withStagedExperiment({ gitConfig: { selfReview: 'recording' } }, exp);
    for (let i = 0; i < 30; i++) expect(resolveStagedConfig(ws.gitConfig, `t-${i}`).arm).toBe('control');
  });
});
describe('buildStagedAssignment', () => {
  const acting = withStagedExperiment({ gitConfig: { selfReview: 'acting' } }, exp);
  test('matches the runner draw, with propensity and version', () => {
    for (let i = 0; i < 30; i++) {
      const row = buildStagedAssignment(acting, `task-${i}`)!;
      const r = resolveStagedConfig(acting.gitConfig, `task-${i}`);
      expect(row.arm).toBe(r.arm);
      expect(row.propensity).toBe(r.propensity!);
      expect(row.policyVersion).toBe(2);
      expect(row.served).toBe(r.arm === 'treatment');
    }
  });
  test('no experiment, recording or off: nothing recorded', () => {
    expect(buildStagedAssignment({ gitConfig: { selfReview: 'acting' } }, 't')).toBeNull();
    expect(buildStagedAssignment(withStagedExperiment({ gitConfig: { selfReview: 'recording' } }, exp), 't')).toBeNull();
    expect(buildStagedAssignment({ gitConfig: {} }, 't')).toBeNull();
  });
});
describe('recordStagedAssignment', () => {
  const acting = withStagedExperiment({ gitConfig: { selfReview: 'acting' } }, exp);
  test('acting with a running experiment: inserts the row, idempotent on (experiment, task)', async () => {
    await recordStagedAssignment(acting, 'task-abc');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].row).toMatchObject({ experimentId: 'exp-1', taskId: 'task-abc', unitType: 'task', unitId: 'task-abc', policyVersion: 2 });
    expect(inserted[0].target).toHaveLength(2);
  });
  test('recording, off, or no experiment: buildStagedAssignment returns null and nothing is inserted', async () => {
    await recordStagedAssignment(withStagedExperiment({ gitConfig: { selfReview: 'recording' } }, exp), 'task-rec');
    await recordStagedAssignment({ gitConfig: { selfReview: 'off' } }, 'task-off');
    await recordStagedAssignment({ gitConfig: { selfReview: 'acting' } }, 'task-noexp');
    expect(inserted).toHaveLength(0);
  });
  test('a failing insert is swallowed, never thrown', async () => {
    insertShouldThrow = true;
    await expect(recordStagedAssignment(acting, 'task-fail')).resolves.toBeUndefined();
    expect(inserted).toHaveLength(0);
  });
});
