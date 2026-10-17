/**
 * The runner queue read (spec c7410e76 R-26, AC-12), rendered to real SQL:
 * it is scoped to the caller's claimable workspaces and pending work only, it
 * orders by the claim candidate query's own ORDER BY, and it evaluates the
 * claim route's own gate predicates. Then the pure half: which gate puts a
 * task under "Not for this runner", which ones are holds, and the grouping.
 * Real Postgres behaviour: apps/web/tests/db/runner-queue.test.ts.
 */
import { describe, it, expect, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PgDialect, QueryBuilder } from 'drizzle-orm/pg-core';
import { asc, desc } from 'drizzle-orm';

mock.module('@buildd/core/db', () => ({ db: { query: {} } }));

const { buildRunnerQueueQuery, classifyRunnerQueueRow, groupRunnerQueue, loadRunnerQueue, runnerQueueGates, runnerQueueWhere, RUNNER_QUEUE_LIMIT } = await import('./claim-order-queue');
const { claimOrderBy, compareClaimOrder, activeWorkerGate, runnerCooldownGate } = await import('./claim-order');
const { missionNotLocal, taskNotReserved } = await import('@/app/api/workers/claim/held-gate');
const claimWhereMod = await import('./claim-candidate-where');
const { roleSlugGate } = await import('@/app/api/workers/claim/role-gate');
const { tasks } = await import('@buildd/core/db/schema');

const dialect = new PgDialect();
const render = (q: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(q).sql.replace(/\$\d+/g, '$?');
const NOW = new Date('2026-03-10T15:00:00Z');
const caller = { accountType: 'service', runner: 'http://localhost:8766', availableSkills: ['builder'], executor: 'host' as const };

describe('the read, rendered', () => {
  const gates = runnerQueueGates(caller, NOW);
  const q = buildRunnerQueueQuery(new QueryBuilder() as any, { workspaceIds: ['ws-a', 'ws-b'], gates }).toSQL();

  it('reads pending tasks in the given workspaces only', () => {
    expect(q.sql).toMatch(/ where \(\("tasks"\."workspace_id" in \(\$\d+, \$\d+\)\) and \("tasks"\."status" = \$\d+\)\) order by /);
    const where = dialect.sqlToQuery(runnerQueueWhere(['ws-a', 'ws-b']));
    expect(where.params).toEqual(['ws-a', 'ws-b', 'pending']);
    expect(q.params).toContain('ws-a');
    expect(q.params).toContain('ws-b');
  });

  it("orders by the claim candidate query's own ORDER BY, priority then age", () => {
    expect(q.sql).toMatch(/order by "tasks"\."priority" desc, "tasks"\."created_at" asc limit \$\d+$/);
    expect(q.params[q.params.length - 1]).toBe(RUNNER_QUEUE_LIMIT + 1);
    // Same terms the claim route passes to sqlOrderByFn.
    expect(claimOrderBy(tasks, { desc, asc }).map(t => render(t))).toEqual([render(desc(tasks.priority)), render(asc(tasks.createdAt))]);
  });

  it('joins only to name the workspace, team and mission; the gates read the outer task', () => {
    expect(q.sql).toContain('inner join "workspaces" on "workspaces"."id" = "tasks"."workspace_id"');
    expect(q.sql).toContain('left join "teams" on "teams"."id" = "workspaces"."team_id"');
    expect(q.sql).toContain('left join "missions" on "missions"."id" = "tasks"."mission_id"');
  });

  it("evaluates the claim route's own predicates, COALESCEd as the explicit-claim probe does", () => {
    const s = q.sql.replace(/\$\d+/g, '$?');
    for (const g of [missionNotLocal(), taskNotReserved(), activeWorkerGate()]) expect(s).toContain(render(g));
    expect(s).toContain(render(runnerCooldownGate(caller.runner, new Date(NOW.getTime() - 60_000))));
    for (const clause of roleSlugGate(['builder'])) expect(s).toContain(render(clause));
  });

  it('covers every gate the shared claim WHERE builds into its WHERE', () => {
    const route = readFileSync(join(import.meta.dir, './claim-candidate-where.ts'), 'utf8');
    const names = [...new Set([...route.matchAll(/gates\.([a-zA-Z]+) =/g)].map(m => m[1]))];
    expect(names.length).toBeGreaterThan(10);
    for (const n of names) expect(Object.keys(gates)).toContain(n);
  });

  it('a user account is not held by runnerPreference, and no runner id means no cooldown, as in the claim route', () => {
    const g = runnerQueueGates({ ...caller, accountType: 'user', runner: null }, NOW);
    expect(g.runnerPreference).toBeUndefined();
    expect(g.runnerCooldown).toBeUndefined();
  });
});

describe('compareClaimOrder', () => {
  it('mirrors claimOrderBy: higher priority first, then older first', () => {
    const rows = [
      { id: 'b', priority: 1, createdAt: '2026-01-02T00:00:00Z' },
      { id: 'c', priority: 5, createdAt: '2026-01-03T00:00:00Z' },
      { id: 'a', priority: 1, createdAt: '2026-01-01T00:00:00Z' },
    ];
    expect([...rows].sort(compareClaimOrder).map(r => r.id)).toEqual(['c', 'a', 'b']);
  });
});

const row = (over: Record<string, unknown> = {}) => ({
  id: 't-1', title: 'a task', workspaceId: 'ws-a', workspaceName: 'alpha', teamId: 'team-1', teamName: 'Acme',
  missionId: null, missionTitle: null, roleSlug: null, backend: null, priority: 0, createdAt: '2026-03-10T10:00:00Z',
  startAt: null, dependsOn: [], workspacePausedUntil: null,
  g_claimFree: true, g_activeWorker: true, g_missionLocal: true, g_taskReserved: true, g_role: true, g_runnerPreference: true,
  g_workspaceExecutor: true, g_subject: true, g_startAt: true, g_taskHeld: true, g_missionHeld: true, g_deps: true,
  g_workspacePaused: true, g_workspaceCap: true, g_runnerCooldown: true,
  ...over,
}) as any;

describe('classifyRunnerQueueRow', () => {
  it('every gate passing: in the queue, nothing holding it', () => {
    const r = classifyRunnerQueueRow(row());
    expect(r.exclusion).toBeNull();
    expect(r.task.holds).toEqual([]);
    expect(r.task.holdUntil).toBeNull();
  });

  it.each([
    ['g_missionLocal', 'local_session'],
    ['g_taskReserved', 'local_session'],
    ['g_claimFree', 'another_runner'],
    ['g_activeWorker', 'another_runner'],
    ['g_runnerPreference', 'runner_type'],
    ['g_role', 'role_missing'],
    ['g_workspaceExecutor', 'workspace_executor'],
    ['g_subject', 'subject_dead'],
  ])('%s failing: not for this runner (%s)', (gate, reason) => {
    expect(classifyRunnerQueueRow(row({ [gate]: false })).exclusion).toBe(reason as any);
    // NULL fails exactly as the claim WHERE treats it; neon may hand back 'f'.
    expect(classifyRunnerQueueRow(row({ [gate]: null })).exclusion).toBe(reason as any);
    expect(classifyRunnerQueueRow(row({ [gate]: 'f' })).exclusion).toBe(reason as any);
  });

  it('a local session outranks a missing role', () => {
    expect(classifyRunnerQueueRow(row({ g_missionLocal: false, g_role: false })).exclusion).toBe('local_session');
  });

  it('holds that lift on their own stay in the queue, named in check order, with the time a start lifts', () => {
    const r = classifyRunnerQueueRow(row({ g_startAt: false, g_deps: false, startAt: '2026-03-11T00:00:00Z' }));
    expect(r.exclusion).toBeNull();
    expect(r.task.holds).toEqual(['deferred', 'deps_blocked']);
    expect(r.task.holdUntil).toBe('2026-03-11T00:00:00.000Z');
  });

  it('a start time says what set it: retries after failures, a usage-limit reset, a credential probe, else a set time', () => {
    const base = { g_startAt: false, startAt: '2026-03-11T00:00:00Z' };
    const cause = (over: Record<string, unknown>) => classifyRunnerQueueRow(row({ ...base, ...over })).task.holdCause;
    expect(cause({ ctxInfraRetryCount: '2' })).toBe('retry_after_failures');
    expect(cause({ ctxBudgetExhausted: 'true' })).toBe('usage_limit_reset');
    expect(cause({ ctxCredentialHold: true, ctxInfraRetryCount: '3' })).toBe('credential_probe');
    expect(cause({})).toBe('scheduled');
    expect(classifyRunnerQueueRow(row({})).task.holdCause).toBeNull();
  });

  it('a workspace pause names when it resumes', () => {
    const r = classifyRunnerQueueRow(row({ g_workspacePaused: false, workspacePausedUntil: new Date('2026-03-10T18:00:00Z') }));
    expect(r.task.holds).toEqual(['workspace_paused']);
    expect(r.task.holdUntil).toBe('2026-03-10T18:00:00.000Z');
  });

  it('a gate not evaluated is not a failure', () => {
    const r = row();
    delete r.g_runnerCooldown;
    delete r.g_runnerPreference;
    expect(classifyRunnerQueueRow(r).exclusion).toBeNull();
  });
});

describe('groupRunnerQueue', () => {
  it('keeps the claim order inside each team, splits out what is not for this runner, and sorts teams by name', () => {
    const teams = groupRunnerQueue([
      row({ id: 't-1', teamId: 'team-z', teamName: 'Zeta' }),
      row({ id: 't-2', teamId: 'team-a', teamName: 'Acme', g_missionLocal: false }),
      row({ id: 't-3', teamId: 'team-a', teamName: 'Acme' }),
      row({ id: 't-4', teamId: 'team-a', teamName: 'Acme', g_deps: false }),
    ]);
    expect(teams.map(t => t.teamName)).toEqual(['Acme', 'Zeta']);
    expect(teams[0].queue.map(t => t.id)).toEqual(['t-3', 't-4']);
    expect(teams[0].notForRunner.map(t => [t.id, t.reason])).toEqual([['t-2', 'local_session']]);
    expect(teams[1].queue.map(t => t.id)).toEqual(['t-1']);
  });
});

describe('loadRunnerQueue', () => {
  it('reads nothing for no workspaces', async () => {
    let read = 0;
    expect(await loadRunnerQueue({ workspaceIds: [], caller }, { read: async () => { read++; return []; } })).toEqual({ teams: [], truncated: false });
    expect(read).toBe(0);
  });

  it('adds estimates only for a team that has them on, newest row per task', async () => {
    const out = await loadRunnerQueue({ workspaceIds: ['ws-a'], caller, now: NOW }, {
      read: async () => [row({ id: 't-1' }), row({ id: 't-2' }), row({ id: 't-3', teamId: 'team-b', teamName: 'Bravo' })],
      estimates: async (teamId) => teamId === 'team-1'
        ? [{ taskId: 't-1', p50Minutes: 39.6 }, { taskId: 't-1', p50Minutes: 10 }]
        : null,
    });
    const acme = out.teams.find(t => t.teamName === 'Acme')!;
    const bravo = out.teams.find(t => t.teamName === 'Bravo')!;
    expect(acme.estimatesOn).toBe(true);
    expect(acme.queue.map(t => t.estimateMinutes)).toEqual([40, null]);
    expect(bravo.estimatesOn).toBe(false);
    expect(bravo.queue[0].estimateMinutes).toBeNull();
  });

  it('names the open PR or lease a queued task would start alongside, never one that holds it', async () => {
    const pr = (taskId: string, prNumber: number) => ({ taskId, prNumber, prUrl: `https://example.test/pull/${prNumber}`, pathManifest: null as string[] | null });
    const out = await loadRunnerQueue({ workspaceIds: ['ws-a'], caller }, {
      read: async () => [
        row({ id: 't-pr', pathManifest: ['apps/web/src/lib/x.ts'] }),
        row({ id: 't-lease', pathManifest: ['apps/web/src/lib/y.ts'] }),
        row({ id: 't-held', pathManifest: ['packages/core/db/schema.ts'] }),
        row({ id: 't-none', pathManifest: ['docs/a.md'] }),
        row({ id: 't-undeclared' }),
      ],
      estimates: async () => null,
      overlaps: async () => ({
        openPrs: new Map([['ws-a', [
          { ...pr('pr-task', 41), pathManifest: ['apps/web/src/lib/x.ts'] },
          { ...pr('schema-task', 42), pathManifest: ['packages/core/db/schema.ts'] },
        ]]]),
        leases: new Map([['ws-a', new Map([['lease-task', ['apps/web/src/lib/y.ts']]])]]),
      }),
    });
    const by = new Map(out.teams[0].queue.map(t => [t.id, t.alongside ?? null]));
    expect(by.get('t-pr')).toEqual({ prNumber: 41, holderTaskId: 'pr-task' });
    expect(by.get('t-lease')).toEqual({ prNumber: null, holderTaskId: 'lease-task' });
    expect(by.get('t-held')).toBeNull();
    expect(by.get('t-none')).toBeNull();
    expect(by.get('t-undeclared')).toBeNull();
    // Never sent to the runner.
    expect(out.teams[0].queue[0]).not.toHaveProperty('pathManifest');
  });

  it('reads no overlaps when no queued task declares files, and a failed read only drops alongside', async () => {
    let reads = 0;
    await loadRunnerQueue({ workspaceIds: ['ws-a'], caller }, { read: async () => [row()], estimates: async () => null, overlaps: async () => { reads++; throw new Error('x'); } });
    expect(reads).toBe(0);
    const out = await loadRunnerQueue({ workspaceIds: ['ws-a'], caller }, {
      read: async () => [row({ pathManifest: ['a.ts'] })], estimates: async () => null, overlaps: async () => { reads++; throw new Error('down'); },
    });
    expect(reads).toBe(1);
    expect(out.teams[0].queue[0].alongside).toBeUndefined();
  });

  it('says when the read hit its row limit', async () => {
    const many = Array.from({ length: RUNNER_QUEUE_LIMIT + 1 }, (_, i) => row({ id: `t-${i}` }));
    const out = await loadRunnerQueue({ workspaceIds: ['ws-a'], caller }, { read: async () => many, estimates: async () => null });
    expect(out.truncated).toBe(true);
    expect(out.teams[0].queue.length).toBe(RUNNER_QUEUE_LIMIT);
  });
});

describe('the claim route and the queue share one candidate WHERE', () => {
  const { claimCandidateWhere } = claimWhereMod;
  const input = { workspaceIds: ['ws-a', 'ws-b'], now: NOW, accountType: 'service', runner: 'http://localhost:8766', availableSkills: ['builder'], executor: 'host' as const };

  it('the route builds its candidate conditions through claimCandidateWhere', () => {
    const route = readFileSync(join(import.meta.dir, '../app/api/workers/claim/route.ts'), 'utf8');
    expect(route).toContain("from '@/lib/claim-candidate-where'");
    expect(route).toMatch(/claimCandidateWhere\(\{/);
    // No second hand-built copy of the gates in the route.
    expect(route).not.toMatch(/claimableConditions\.push\(/);
  });

  it('the queue gates are the very predicates the route pushes into its WHERE', () => {
    const { conditions, gates } = claimCandidateWhere(input);
    const queueGates = runnerQueueGates(caller, NOW);
    const rendered = conditions.map(render);
    for (const [name, predicate] of Object.entries(queueGates)) {
      expect(rendered).toContain(render(predicate!));
      expect(render(gates[name as keyof typeof gates]!)).toBe(render(predicate!));
    }
    expect(Object.keys(queueGates).sort()).toEqual(Object.keys(gates).sort());
  });

  it('scopes to the workspaces and pending status, then every gate', () => {
    const { conditions, gates } = claimCandidateWhere(input);
    expect(render(conditions[0])).toContain('"workspace_id" in');
    expect(render(conditions[1])).toContain('"status" =');
    expect(conditions.length).toBe(2 + Object.keys(gates).length);
  });

  it('an admin force claim lifts the gates the route lifts', () => {
    const { gates } = claimCandidateWhere({ ...input, forceClaim: true, taskId: 't-1' });
    for (const lifted of ['startAt', 'missionHeld', 'missionLocal', 'subject', 'deps', 'workspaceCap', 'workspaceExecutor', 'workspacePaused'] as const) {
      expect(gates[lifted]).toBeUndefined();
    }
    expect(gates.activeWorker).toBeDefined();
    expect(gates.taskHeld).toBeDefined();
  });

  it('an interactive explicit claim skips the local, cooldown, role and paused gates but keeps held', () => {
    const { gates } = claimCandidateWhere({ ...input, taskId: 't-1', interactiveSession: true, accountId: 'acct', availableSkills: ['designer'] });
    expect(gates.missionLocal).toBeUndefined();
    expect(gates.runnerCooldown).toBeUndefined();
    expect(gates.role).toBeUndefined();
    expect(gates.workspacePaused).toBeUndefined();
    expect(gates.missionHeld).toBeDefined();
  });
});
