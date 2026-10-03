import { describe, it, expect, mock } from 'bun:test';

/**
 * The apply half of role routing (role-routing.md §6(c)). The shadow's
 * decision call, policy check and role query are injected, and so is the
 * guarded write, so nothing here reaches the DB or the network. The SQL guard
 * itself is pinned by reading the module source.
 */

const {
  applyTaskRoleDecision,
  runTaskRoleRouting,
  scheduleTaskRoleRouting,
  TASK_ROLE_MIN_CONFIDENCE,
  taskRoleMinConfidence,
  DECISION_APPLY_LOG_PREFIX,
} = await import('./task-role-apply');
const { TASK_ROLE_APPLY_CAPABILITY, TASK_ROLE_CAPABILITY } = await import('./task-role-decision');
const { resolveClaimModelInputs } = await import('@buildd/core/role-model-routing');
const { installPolicyOverrides, resetPolicyOverrides } = await import('./policy-overrides');
type TaskRoleShadowRecord = import('./task-role-decision').TaskRoleShadowRecord;
type RoleRow = import('./task-role-decision').RoleRow;

const JEV = 'typesafe/jev-1.13-20260917';

function record(over: Partial<TaskRoleShadowRecord> = {}): TaskRoleShadowRecord {
  return {
    site: 'task_role', v: `tr1|${JEV}`, fingerprint: 'fp-abc123', taskId: 'task-1', workspaceId: 'ws-1',
    candidates: ['builder', 'researcher'], excluded: {},
    decision: 'builder', confidence: 0.97, probabilities: { builder: 0.97, researcher: 0.03 },
    kindDecision: null, kindConfidence: null, kindHeuristic: null, claimedBeforeDecision: false,
    model: JEV, latencyMs: 100, inputTokens: 400, costUsd: 0.00003,
    ...over,
  };
}

const NOW = () => new Date('2026-10-02T12:00:00Z');
const INPUT = { taskId: 'task-1', statedRoleSlug: null, teamId: 'team-1' };

describe('applyTaskRoleDecision', () => {
  it('writes a confident in-set answer once, with the roleInferred stamp', async () => {
    const write = mock(async () => true);
    const lines: string[] = [];
    const res = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record(), applyEnabled: true }, {
      write, now: NOW, log: l => lines.push(l), minConfidence: 0.9,
    });
    expect(res.outcome).toBe('applied');
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0]).toEqual(['task-1', {
      slug: 'builder', confidence: 0.97, model: JEV, candidates: 2, at: '2026-10-02T12:00:00.000Z',
    }] as never);
    expect(lines[0].startsWith(`${DECISION_APPLY_LOG_PREFIX} `)).toBe(true);
    expect(JSON.parse(lines[0].slice(DECISION_APPLY_LOG_PREFIX.length + 1))).toMatchObject({ outcome: 'applied', decision: 'builder' });
  });

  it('no rows back is lost_race, logged, and nothing else happens', async () => {
    const lines: string[] = [];
    const res = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record(), applyEnabled: true }, {
      write: async () => false, log: l => lines.push(l), minConfidence: 0.9,
    });
    expect(res.outcome).toBe('lost_race');
    expect(res.stamp).toBeUndefined();
    expect(lines[0]).toContain('"outcome":"lost_race"');
  });

  it('below the threshold leaves the role null', async () => {
    const write = mock(async () => true);
    const res = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record({ confidence: 0.89 }), applyEnabled: true }, {
      write, log: () => {}, minConfidence: 0.9,
    });
    expect(res.outcome).toBe('below_threshold');
    expect(write).not.toHaveBeenCalled();
  });

  it('writes nothing unless the team opted into apply', async () => {
    const write = mock(async () => true);
    for (const applyEnabled of [false, undefined]) {
      const res = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record(), applyEnabled }, { write, log: () => {} });
      expect(res.outcome).toBe('not_enabled');
    }
    expect(write).not.toHaveBeenCalled();
  });

  it('never overwrites a caller-supplied role', async () => {
    const write = mock(async () => true);
    const a = await applyTaskRoleDecision({ taskId: 'task-1', statedRoleSlug: 'researcher' }, { outcome: 'logged', record: record(), applyEnabled: true }, { write, log: () => {} });
    const b = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record({ stated: 'researcher' }), applyEnabled: true }, { write, log: () => {} });
    expect([a.outcome, b.outcome]).toEqual(['stated', 'stated']);
    expect(write).not.toHaveBeenCalled();
  });

  it('never writes a slug outside the candidate set or an explicit-opt-in slug', async () => {
    const write = mock(async () => true);
    const outside = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record({ decision: 'organizer' }), applyEnabled: true }, { write, log: () => {}, minConfidence: 0.5 });
    const explicit = await applyTaskRoleDecision(INPUT, {
      outcome: 'logged', record: record({ decision: 'visual-auditor', candidates: ['builder', 'visual-auditor'] }), applyEnabled: true,
    }, { write, log: () => {}, minConfidence: 0.5 });
    expect([outside.outcome, explicit.outcome]).toEqual(['not_candidate', 'not_candidate']);
    expect(write).not.toHaveBeenCalled();
  });

  it('a failed or skipped look, or a model the threshold was not measured on, leaves the role null', async () => {
    const write = mock(async () => true);
    for (const shadow of [
      { outcome: 'error' as const, applyEnabled: true },
      { outcome: 'too_few_candidates' as const, applyEnabled: true },
      { outcome: 'logged' as const, record: record({ decision: null }), applyEnabled: true },
    ]) {
      expect((await applyTaskRoleDecision(INPUT, shadow, { write, log: () => {} })).outcome).toBe('no_decision');
    }
    const other = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record({ model: 'openai/gpt-x' }), applyEnabled: true }, { write, log: () => {}, minConfidence: 0.5 });
    expect(other.outcome).toBe('unmeasured_model');
    expect(write).not.toHaveBeenCalled();
  });

  it('a throwing write is an error, never a throw', async () => {
    const res = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record(), applyEnabled: true }, {
      write: async () => { throw new Error('db down'); }, log: () => {}, minConfidence: 0.9,
    });
    expect(res.outcome).toBe('error');
  });

  it('writes a decision-ledger row on every path that actually asked, and none for upstream skips', async () => {
    const write = mock(async () => true);
    const recordDecision = mock(async () => {});

    await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record(), applyEnabled: true }, {
      write, log: () => {}, minConfidence: 0.9, recordDecision,
    });
    expect(recordDecision).toHaveBeenCalledTimes(1);
    expect(recordDecision.mock.calls[0][0]).toMatchObject({
      teamId: 'team-1', capability: 'task_role_shadow', fingerprint: 'fp-abc123',
      verdict: 'builder', confidence: 0.97, appliedAnswer: 'builder', applied: true, status: 'applied',
    });

    recordDecision.mockClear();
    await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record({ confidence: 0.5 }), applyEnabled: true }, {
      write, log: () => {}, minConfidence: 0.9, recordDecision,
    });
    expect(recordDecision.mock.calls[0][0]).toMatchObject({ applied: false, status: 'suggested', reason: 'below_threshold', appliedAnswer: null });

    recordDecision.mockClear();
    await applyTaskRoleDecision(INPUT, { outcome: 'error', fingerprint: 'fp-err', applyEnabled: true }, { write, log: () => {}, recordDecision });
    expect(recordDecision.mock.calls[0][0]).toMatchObject({ applied: false, status: 'fallback', fingerprint: 'fp-err', ruleAnswer: null });

    recordDecision.mockClear();
    await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record(), applyEnabled: false }, { write, log: () => {}, recordDecision });
    expect(recordDecision).not.toHaveBeenCalled();

    recordDecision.mockClear();
    await applyTaskRoleDecision({ taskId: 'task-1', statedRoleSlug: 'researcher', teamId: 'team-1' }, { outcome: 'logged', record: record(), applyEnabled: true }, { write, log: () => {}, recordDecision });
    expect(recordDecision).not.toHaveBeenCalled();
  });

  it('never throws when the ledger write fails', async () => {
    const res = await applyTaskRoleDecision(INPUT, { outcome: 'logged', record: record(), applyEnabled: true }, {
      write: async () => true, log: () => {}, minConfidence: 0.9, recordDecision: async () => { throw new Error('db down'); },
    });
    expect(res.outcome).toBe('applied');
  });

  it('the guarded write only touches an unclaimed, pending, role-less row', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const src = readFileSync(join(import.meta.dir, 'task-role-apply.ts'), 'utf8');
    const fn = src.slice(src.indexOf('async function dbWriteInferredRole'), src.indexOf('export interface ApplyDeps'));
    expect(fn).toContain('isNull(tasks.roleSlug)');
    expect(fn).toContain("eq(tasks.status, 'pending')");
    expect(fn).toContain('isNull(tasks.claimedAt)');
    expect(fn).toContain("'roleInferred'");
    expect(fn).toContain('.returning(');
    expect(fn).not.toContain('db.transaction');
  });
});

describe('the threshold', () => {
  it('defaults to the public value and follows the private policy record', () => {
    resetPolicyOverrides();
    expect(taskRoleMinConfidence()).toBe(TASK_ROLE_MIN_CONFIDENCE);
    installPolicyOverrides({ values: { taskRoleMinConfidencePct: 93 }, roles: {} });
    expect(taskRoleMinConfidence()).toBeCloseTo(0.93);
    resetPolicyOverrides();
  });
});

describe('an inferred role never changes the model', () => {
  it('the claim-time model inputs ignore an inferred role entirely', () => {
    for (const roleModel of ['opus', 'premium-plus', 'haiku', 'claude-sonnet-5']) {
      const inferred = resolveClaimModelInputs({ pin: null, taskTier: null, roleModel, roleInferred: true });
      const none = resolveClaimModelInputs({ pin: null, taskTier: null, roleModel: null, roleInferred: false });
      expect(inferred).toEqual(none);
    }
  });
});

describe('runTaskRoleRouting', () => {
  const routed = (slug: string): RoleRow => ({
    slug, name: slug[0].toUpperCase() + slug.slice(1), workspaceId: null, enabled: true, isRole: true,
    metadata: { routing: { whenToUse: `Work that the ${slug} role should pick up, described.` } },
    allowedTools: [], connectorRefs: [], defaultBackend: null,
  });
  const TASK = {
    taskId: 'task-1', teamId: 'team-1', workspaceId: 'ws-1', title: 'Add CSV export', description: 'x',
    pathManifestIsConcrete: false, inMission: false, outputRequirement: 'auto', backend: 'claude', emitsPlan: false, kind: 'engineering',
  };
  const decide = mock(async () => ({
    ok: true as const,
    answers: { role: { type: 'choice' as const, choice: 'Builder', confidence: 0.96, probabilities: { Builder: 0.96, Researcher: 0.04 } } },
    model: JEV, usage: { inputTokens: 1, outputTokens: 0, costUsd: 0 }, latencyMs: 1, attempts: 1,
  }));

  it('asks under task_role_apply when the team enabled it, then writes', async () => {
    const asked: string[] = [];
    const write = mock(async () => true);
    const res = await runTaskRoleRouting(TASK, {
      resolveAccess: async ({ capability }) => { asked.push(capability); return { ok: true, apiKey: 'k', model: JEV }; },
      decide: decide as never, loadRoles: async () => [routed('builder'), routed('researcher')],
      readClaimedAt: async () => null, log: () => {},
      apply: { write, log: () => {}, minConfidence: 0.9 },
    });
    expect(asked).toEqual([TASK_ROLE_APPLY_CAPABILITY]);
    expect(res.apply.outcome).toBe('applied');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('applies even when only task_role_shadow is enabled — apply is the default now, not a second opt-in', async () => {
    const asked: string[] = [];
    const write = mock(async () => true);
    const res = await runTaskRoleRouting(TASK, {
      resolveAccess: async ({ capability }) => {
        asked.push(capability);
        return capability === TASK_ROLE_CAPABILITY
          ? { ok: true, apiKey: 'k', model: JEV }
          : { ok: false, error: { kind: 'capability_disabled', capability } } as never;
      },
      decide: decide as never, loadRoles: async () => [routed('builder'), routed('researcher')],
      readClaimedAt: async () => null, log: () => {},
      apply: { write, log: () => {}, minConfidence: 0.9 },
    });
    expect(asked).toEqual([TASK_ROLE_APPLY_CAPABILITY, TASK_ROLE_CAPABILITY]);
    expect(res.shadow.outcome).toBe('logged');
    expect(res.apply.outcome).toBe('applied');
    expect(write).toHaveBeenCalledTimes(1);
  });

  it('a stated-role task never asks under the apply capability', async () => {
    const asked: string[] = [];
    await runTaskRoleRouting({ ...TASK, statedRoleSlug: 'builder' }, {
      resolveAccess: async ({ capability }) => { asked.push(capability); return { ok: true, apiKey: 'k', model: JEV }; },
      decide: decide as never, loadRoles: async () => [routed('builder'), routed('researcher')],
      readClaimedAt: async () => null, log: () => {},
      apply: { write: async () => true, log: () => {} },
    });
    expect(asked).not.toContain(TASK_ROLE_APPLY_CAPABILITY);
  });

  it('scheduleTaskRoleRouting hands the run to after(), and fires it directly outside a request scope', async () => {
    const scheduled: Array<() => Promise<unknown>> = [];
    const write = mock(async () => true);
    const deps = {
      resolveAccess: async () => ({ ok: true as const, apiKey: 'k', model: JEV }),
      decide: decide as never, loadRoles: async () => [routed('builder'), routed('researcher')],
      readClaimedAt: async () => null, log: () => {}, apply: { write, log: () => {}, minConfidence: 0.9 },
    };
    scheduleTaskRoleRouting(TASK, fn => { scheduled.push(fn); }, deps);
    expect(write).not.toHaveBeenCalled();
    await scheduled[0]();
    expect(write).toHaveBeenCalledTimes(1);

    scheduleTaskRoleRouting(TASK, () => { throw new Error('after() outside request scope'); }, deps);
    await new Promise(r => setTimeout(r, 0));
    await new Promise(r => setTimeout(r, 0));
    expect(write).toHaveBeenCalledTimes(2);
  });
});
