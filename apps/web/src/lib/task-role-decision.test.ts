import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The task role shadow (role-routing.md §3, §5, §6(a)): the candidate set is
 * built in code, the opt_in gate stops everything before a query or a call,
 * and the run only ever logs. `decisionCall`, the policy check, the role query,
 * the connector check and the claimedAt read are injected, so nothing here
 * reaches the DB or the network.
 */

const {
  runTaskRoleShadow,
  scheduleTaskRoleShadow,
  buildRoleCandidates,
  filterRoleCandidates,
  resolveEffectiveRoles,
  buildRoleQuestion,
  buildTaskRoleState,
  inStatedRoleSample,
  TASK_ROLE_CAPABILITY,
  SHADOW_TIMEOUT_MS,
  SHADOW_DESCRIPTION_CHARS,
  DECISION_SHADOW_LOG_PREFIX,
  TASK_KIND_QUESTION,
} = await import('./task-role-decision');
type RoleRow = import('./task-role-decision').RoleRow;

const routed = (whenToUse: string, notFor?: string) => ({ routing: { whenToUse, ...(notFor ? { notFor } : {}) } });

function role(slug: string, over: Partial<RoleRow> = {}): RoleRow {
  return {
    slug,
    name: slug[0].toUpperCase() + slug.slice(1),
    workspaceId: null,
    enabled: true,
    isRole: true,
    metadata: routed(`Work that the ${slug} role should pick up, described.`),
    allowedTools: [],
    connectorRefs: [],
    defaultBackend: null,
    ...over,
  };
}

const TASK = {
  workspaceId: 'ws-1',
  backend: 'claude',
  outputRequirement: 'auto',
  pathManifestIsConcrete: false,
  emitsPlan: false,
};

describe('filterRoleCandidates — each exclusion rule', () => {
  it('keeps a described, enabled, plain role', () => {
    const { candidates, excluded } = filterRoleCandidates([role('builder'), role('researcher')], TASK);
    expect(candidates.map(c => c.slug)).toEqual(['builder', 'researcher']);
    expect(excluded).toEqual({});
  });

  it('excludes a disabled role', () => {
    const { candidates, excluded } = filterRoleCandidates([role('builder', { enabled: false })], TASK);
    expect(candidates).toEqual([]);
    expect(excluded.builder).toBe('disabled');
  });

  it('excludes an EXPLICIT_ROLE_SLUGS entry even with routing text', () => {
    const { candidates, excluded } = filterRoleCandidates([role('visual-auditor')], TASK);
    expect(candidates).toEqual([]);
    expect(excluded['visual-auditor']).toBe('explicit');
  });

  it('excludes a role opted out with routing.disabled', () => {
    const { excluded } = filterRoleCandidates([role('reviewer', { metadata: { routing: { disabled: true } } })], TASK);
    expect(excluded.reviewer).toBe('routing_disabled');
  });

  it('never guesses from the description: no whenToUse ⇒ excluded', () => {
    for (const metadata of [{}, null, { routing: {} }, { routing: { whenToUse: '   ' } }, { routing: { notFor: 'Anything else' } }]) {
      const { excluded } = filterRoleCandidates([role('writer', { metadata })], TASK);
      expect(excluded.writer).toBe('no_when_to_use');
    }
  });

  it('excludes a read-only role from a pr_required task', () => {
    const readOnly = role('researcher', { allowedTools: ['Read', 'Grep', 'WebSearch'] });
    const { excluded } = filterRoleCandidates([readOnly], { ...TASK, outputRequirement: 'pr_required' });
    expect(excluded.researcher).toBe('tools');
  });

  it('excludes a read-only role from a task with a concrete pathManifest', () => {
    const readOnly = role('researcher', { allowedTools: ['Read'] });
    expect(filterRoleCandidates([readOnly], { ...TASK, pathManifestIsConcrete: true }).excluded.researcher).toBe('tools');
  });

  it('applies no tool filter to artifact work, a plan, or a role with all tools or any write tool', () => {
    const readOnly = role('researcher', { allowedTools: ['Read'] });
    expect(filterRoleCandidates([readOnly], { ...TASK, outputRequirement: 'artifact_required' }).candidates).toHaveLength(1);
    expect(filterRoleCandidates([readOnly], { ...TASK, outputRequirement: 'pr_required', emitsPlan: true }).candidates).toHaveLength(1);
    for (const allowedTools of [[], ['Read', 'Bash'], ['Edit'], ['Write']]) {
      expect(filterRoleCandidates([role('builder', { allowedTools })], { ...TASK, outputRequirement: 'pr_required' }).candidates).toHaveLength(1);
    }
  });

  it('excludes a role whose defaultBackend differs from the task backend', () => {
    const codexRole = role('specialist', { defaultBackend: 'codex' });
    expect(filterRoleCandidates([codexRole], TASK).excluded.specialist).toBe('backend');
    expect(filterRoleCandidates([codexRole], { ...TASK, backend: 'codex' }).candidates).toHaveLength(1);
    expect(filterRoleCandidates([role('builder', { defaultBackend: null })], TASK).candidates).toHaveLength(1);
  });

  it('sorts candidates by slug so the same set always makes the same request', () => {
    const { candidates } = filterRoleCandidates([role('writer'), role('analyst'), role('builder')], TASK);
    expect(candidates.map(c => c.slug)).toEqual(['analyst', 'builder', 'writer']);
  });
});

describe('resolveEffectiveRoles — resolved like the claim route', () => {
  it('a workspace override wins over the team default', () => {
    const rows = [role('builder'), role('builder', { workspaceId: 'ws-1', name: 'WS Builder' })];
    expect(resolveEffectiveRoles(rows, 'ws-1').map(r => r.name)).toEqual(['WS Builder']);
  });

  it("ignores another workspace's override", () => {
    const rows = [role('builder'), role('builder', { workspaceId: 'ws-2', name: 'Other' })];
    expect(resolveEffectiveRoles(rows, 'ws-1').map(r => r.name)).toEqual(['Builder']);
  });

  it('a disabled override does not fall back to an enabled team default', () => {
    const rows = [role('builder'), role('builder', { workspaceId: 'ws-1', enabled: false })];
    const { excluded } = filterRoleCandidates(resolveEffectiveRoles(rows, 'ws-1'), TASK);
    expect(excluded.builder).toBe('disabled');
  });

  it('routing is field-level: an override without routing inherits the default text', () => {
    const rows = [role('builder'), role('builder', { workspaceId: 'ws-1', metadata: { other: 1 } })];
    const { candidates } = filterRoleCandidates(resolveEffectiveRoles(rows, 'ws-1'), TASK);
    expect(candidates).toHaveLength(1);
  });

  it('an override can opt the role out for one workspace', () => {
    const rows = [role('builder'), role('builder', { workspaceId: 'ws-1', metadata: { routing: { disabled: true } } })];
    expect(filterRoleCandidates(resolveEffectiveRoles(rows, 'ws-1'), TASK).excluded.builder).toBe('routing_disabled');
  });
});

describe('buildRoleCandidates — connectors', () => {
  it('excludes a role whose connectors are unusable, and only checks roles that mount some', async () => {
    const checked: string[] = [];
    const { candidates, excluded } = await buildRoleCandidates({ ...TASK, teamId: 'team-1' }, {
      loadRoles: async () => [role('builder'), role('ops', { connectorRefs: ['c-1'] }), role('pm', { connectorRefs: ['c-2'] })],
      connectorsUnusable: async (slug) => { checked.push(slug); return slug === 'ops'; },
    });
    expect(checked.sort()).toEqual(['ops', 'pm']);
    expect(candidates.map(c => c.slug)).toEqual(['builder', 'pm']);
    expect(excluded.ops).toBe('connectors');
  });

  it('a failed connector look excludes the role rather than guessing', async () => {
    const { excluded } = await buildRoleCandidates({ ...TASK, teamId: 'team-1' }, {
      loadRoles: async () => [role('ops', { connectorRefs: ['c-1'] })],
      connectorsUnusable: async () => { throw new Error('db down'); },
    });
    expect(excluded.ops).toBe('connectors');
  });
});

describe('buildRoleQuestion', () => {
  it('needs at least two candidates', () => {
    expect(buildRoleQuestion([])).toBeNull();
    expect(buildRoleQuestion([{ slug: 'builder', name: 'Builder', whenToUse: 'x'.repeat(20), connectorRefs: [] }])).toBeNull();
  });

  it('labels by name, disambiguates a shared name by slug, and renders "Not for"', () => {
    const q = buildRoleQuestion([
      { slug: 'b2', name: 'Builder', whenToUse: 'Second builder work.', connectorRefs: [] },
      { slug: 'b1', name: 'Builder', whenToUse: 'First builder work.', notFor: 'Research (Researcher).', connectorRefs: [] },
      { slug: 'researcher', name: 'Researcher', whenToUse: 'Investigations.', connectorRefs: [] },
    ])!;
    expect(Object.keys(q.question.criteria)).toEqual(['Builder (b1)', 'Builder (b2)', 'Researcher']);
    expect(q.question.criteria['Builder (b1)']).toBe('First builder work. Not for: Research (Researcher).');
    expect(q.question.criteria.Researcher).toBe('Investigations.');
    expect(q.slugFor.get('Builder (b2)')).toBe('b2');
  });
});

describe('buildTaskRoleState — the §5 minimal state', () => {
  it('sends only the listed fields, truncates the description, drops advisory paths', () => {
    const input = {
      title: '  Add a thing  ', label: 'thing', kind: null, description: 'd'.repeat(SHADOW_DESCRIPTION_CHARS + 50),
      pathManifest: ['**'], pathManifestIsConcrete: false, creationSource: 'mcp', inMission: true, outputRequirement: 'pr_required',
      // Never sent, even when handed in:
      context: { failureContext: 'secret log' }, missionTitle: 'M', teamId: 't',
    };
    const state = buildTaskRoleState(input as Parameters<typeof buildTaskRoleState>[0]);
    expect(Object.keys(state)).toEqual(['task']);
    expect(Object.keys(state.task).sort()).toEqual(['description', 'inMission', 'kind', 'label', 'output', 'paths', 'source', 'title']);
    expect(state.task.title).toBe('Add a thing');
    expect(state.task.description.length).toBe(SHADOW_DESCRIPTION_CHARS + 1);
    expect(state.task.paths).toBeNull();
    expect(JSON.stringify(state)).not.toContain('secret log');
  });

  it('keeps at most 20 concrete paths', () => {
    const paths = Array.from({ length: 30 }, (_, i) => `src/f${i}.ts`);
    const state = buildTaskRoleState({ title: 't', pathManifest: paths, pathManifestIsConcrete: true, inMission: false });
    expect(state.task.paths).toHaveLength(20);
  });
});

// ── The run ──────────────────────────────────────────────────────────────────

const INPUT = {
  taskId: 'task-1',
  teamId: 'team-1',
  workspaceId: 'ws-1',
  accountId: 'acct-1',
  title: 'Add CSV export to the usage page',
  description: 'Users want to download usage.',
  pathManifestIsConcrete: false,
  inMission: false,
  outputRequirement: 'auto',
  backend: 'claude',
  emitsPlan: false,
  kind: null,
  kindHeuristic: null,
};

const ALLOWED = async () => ({ ok: true as const, apiKey: 'k', model: 'jev' });
const DISABLED = async () => ({ ok: false as const, error: { kind: 'capability_disabled' as const, capability: 'task_role_shadow' as const } });

function okResult(roleChoice: string, confidence = 0.91, kind?: string) {
  return {
    ok: true as const,
    answers: {
      role: { type: 'choice' as const, choice: roleChoice, confidence, probabilities: { [roleChoice]: confidence, Researcher: 1 - confidence } },
      ...(kind ? { kind: { type: 'choice' as const, choice: kind, confidence: 0.8, probabilities: { [kind]: 0.8 } } } : {}),
    },
    model: '~typesafe/jev-test',
    usage: { inputTokens: 400, outputTokens: 0, costUsd: 0.00003 },
    latencyMs: 120,
    attempts: 1,
  };
}

const ROLES = async () => [role('builder'), role('researcher'), role('reviewer', { metadata: { routing: { disabled: true } } })];

describe('runTaskRoleShadow', () => {
  it('opt_in gate off → no candidate query and no call', async () => {
    const decide = mock(async () => okResult('Builder'));
    const loadRoles = mock(ROLES);
    const res = await runTaskRoleShadow(INPUT, { resolveAccess: DISABLED, decide: decide as never, loadRoles, log: () => {} });
    expect(res.outcome).toBe('disabled');
    expect(loadRoles).not.toHaveBeenCalled();
    expect(decide).not.toHaveBeenCalled();
  });

  it('the real policy check refuses a team that has not listed the capability', async () => {
    const { resolveDecisionAccess } = await import('@buildd/core/decision-client');
    const decide = mock(async () => okResult('Builder'));
    for (const enabledDecisionShadows of [null, [], ['something_else']]) {
      const res = await runTaskRoleShadow(INPUT, {
        resolveAccess: (o) => resolveDecisionAccess({ ...o, team: { inferenceFeatureModes: null, decisionModel: null, enabledDecisionShadows } }),
        decide: decide as never, loadRoles: ROLES, log: () => {},
      });
      expect(res.outcome).toBe('disabled');
    }
    expect(decide).not.toHaveBeenCalled();
  });

  it('skips the call with fewer than two candidates', async () => {
    const decide = mock(async () => okResult('Builder'));
    const res = await runTaskRoleShadow(INPUT, {
      resolveAccess: ALLOWED, decide: decide as never, log: () => {},
      loadRoles: async () => [role('builder'), role('writer', { metadata: {} })],
    });
    expect(res.outcome).toBe('too_few_candidates');
    expect(res.applyEnabled).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  });

  it('never sends a sensitive workspace out', async () => {
    const decide = mock(async () => okResult('Builder'));
    const resolveAccess = mock(ALLOWED);
    const res = await runTaskRoleShadow({ ...INPUT, dataClass: 'sensitive' }, { resolveAccess, decide: decide as never, loadRoles: ROLES, log: () => {} });
    expect(res.outcome).toBe('sensitive');
    expect(res.applyEnabled).toBe(true);
    expect(decide).not.toHaveBeenCalled();
  });

  it('a missing key is its own outcome, distinct from a capability that is off', async () => {
    const res = await runTaskRoleShadow(INPUT, {
      resolveAccess: async () => ({ ok: false, error: { kind: 'missing_key' } }) as never,
      decide: mock(async () => okResult('Builder')) as never, loadRoles: ROLES, log: () => {},
    });
    expect(res).toMatchObject({ outcome: 'no_key', applyEnabled: true });
  });

  it('asks role and kind in one call with a 3s deadline, and logs slugs and numbers only', async () => {
    const lines: string[] = [];
    const decide = mock(async (_p: unknown) => okResult('Builder', 0.91, 'engineering'));
    const res = await runTaskRoleShadow({ ...INPUT, kindHeuristic: 'engineering' }, {
      resolveAccess: async ({ capability }) => capability === TASK_ROLE_CAPABILITY ? ALLOWED() : DISABLED(), decide: decide as never, loadRoles: ROLES,
      readClaimedAt: async () => new Date(), log: (l) => lines.push(l),
    });
    expect(res.outcome).toBe('logged');
    const args = decide.mock.calls[0][0] as { capability: string; timeoutMs: number; questions: Record<string, { criteria: Record<string, unknown> }>; state: { task: Record<string, unknown> } };
    expect(args.capability).toBe(TASK_ROLE_CAPABILITY);
    expect(args.timeoutMs).toBe(SHADOW_TIMEOUT_MS);
    expect(Object.keys(args.questions)).toEqual(['role', 'kind']);
    expect(Object.keys(args.questions.role.criteria)).toEqual(['Builder', 'Researcher']);
    expect(args.questions.kind).toBe(TASK_KIND_QUESTION);

    expect(lines).toHaveLength(1);
    expect(lines[0].startsWith(`${DECISION_SHADOW_LOG_PREFIX} `)).toBe(true);
    const rec = JSON.parse(lines[0].slice(DECISION_SHADOW_LOG_PREFIX.length + 1));
    expect(rec).toMatchObject({
      site: 'task_role', taskId: 'task-1', workspaceId: 'ws-1',
      candidates: ['builder', 'researcher'], excluded: { reviewer: 'routing_disabled' },
      decision: 'builder', confidence: 0.91, kindDecision: 'engineering', kindHeuristic: 'engineering',
      claimedBeforeDecision: true, inputTokens: 400, costUsd: 0.00003,
    });
    expect(rec.probabilities).toEqual({ builder: 0.91, researcher: expect.any(Number) });
    expect(lines[0]).not.toContain(INPUT.title);
    expect(lines[0]).not.toContain(INPUT.description);
    expect(lines[0]).not.toContain('should pick up');
  });

  it('does not ask kind when the caller stated one', async () => {
    const decide = mock(async (_p: unknown) => okResult('Researcher'));
    const res = await runTaskRoleShadow({ ...INPUT, kind: 'research' }, {
      resolveAccess: ALLOWED, decide: decide as never, loadRoles: ROLES, readClaimedAt: async () => null, log: () => {},
    });
    expect(Object.keys((decide.mock.calls[0][0] as { questions: object }).questions)).toEqual(['role']);
    expect(res.record).toMatchObject({ decision: 'researcher', kindDecision: null, claimedBeforeDecision: false });
  });

  it('shadows a stated-role task only in the deterministic sample, and marks it', async () => {
    const ids = Array.from({ length: 200 }, (_, i) => `task-${i}`);
    const sampled = ids.filter(inStatedRoleSample);
    expect(sampled.length).toBeGreaterThan(10);
    expect(sampled.length).toBeLessThan(80);
    const notSampled = ids.find(id => !inStatedRoleSample(id))!;

    const decide = mock(async () => okResult('Builder'));
    const skip = await runTaskRoleShadow({ ...INPUT, taskId: notSampled, statedRoleSlug: 'builder' }, { resolveAccess: ALLOWED, decide: decide as never, loadRoles: ROLES, log: () => {} });
    expect(skip.outcome).toBe('not_sampled');
    expect(decide).not.toHaveBeenCalled();

    const hit = await runTaskRoleShadow({ ...INPUT, taskId: sampled[0], statedRoleSlug: 'builder' }, {
      resolveAccess: ALLOWED, decide: decide as never, loadRoles: ROLES, readClaimedAt: async () => null, log: () => {},
    });
    expect(hit.record?.stated).toBe('builder');
  });

  it('logs a failed call and never throws', async () => {
    const lines: string[] = [];
    const failed = await runTaskRoleShadow(INPUT, {
      resolveAccess: ALLOWED, loadRoles: ROLES, log: (l) => lines.push(l),
      decide: (async () => ({ ok: false, error: { kind: 'timeout' }, latencyMs: 3000, attempts: 2 })) as never,
    });
    expect(failed.outcome).toBe('error');
    expect(lines[0]).toContain('"error":"timeout"');

    const thrown = await runTaskRoleShadow(INPUT, {
      resolveAccess: ALLOWED, log: () => {}, decide: (async () => okResult('Builder')) as never,
      loadRoles: async () => { throw new Error('db down'); },
    });
    expect(thrown.outcome).toBe('error');
  });

  it('never mutates the task: the input is untouched and the module has no write path', async () => {
    const input = structuredClone({ ...INPUT, pathManifest: ['src/a.ts'] });
    const before = JSON.stringify(input);
    await runTaskRoleShadow(input, {
      resolveAccess: ALLOWED, decide: (async () => okResult('Builder', 0.99, 'engineering')) as never,
      loadRoles: ROLES, readClaimedAt: async () => null, log: () => {},
    });
    expect(JSON.stringify(input)).toBe(before);

    const src = readFileSync(join(import.meta.dir, 'task-role-decision.ts'), 'utf8');
    expect(src).not.toMatch(/\bdb\s*\.\s*(update|insert|delete|execute)\s*\(/);
    expect(src).not.toMatch(/\.set\s*\(\s*\{/);
    expect(src).not.toMatch(/sql`/);
  });
});

describe('scheduleTaskRoleShadow', () => {
  it('hands the run to after(), and fires it directly outside a request scope', async () => {
    const scheduled: Array<() => Promise<unknown>> = [];
    const decide = mock(async () => okResult('Builder'));
    const deps = { resolveAccess: ALLOWED, decide: decide as never, loadRoles: ROLES, readClaimedAt: async () => null, log: () => {} };
    scheduleTaskRoleShadow(INPUT, fn => { scheduled.push(fn); }, deps);
    expect(decide).not.toHaveBeenCalled();
    await scheduled[0]();
    expect(decide).toHaveBeenCalledTimes(1);

    scheduleTaskRoleShadow(INPUT, () => { throw new Error('after() outside request scope'); }, deps);
    await new Promise(r => setTimeout(r, 0));
    expect(decide).toHaveBeenCalledTimes(2);
  });
});
