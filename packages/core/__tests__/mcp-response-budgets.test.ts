/**
 * Response-size budgets for the buildd actions agents call most.
 *
 * Every reply below is rendered from a representative fixture (shaped like a
 * busy workspace, with no real data) and measured with the same estimate the
 * tool-surface budget uses: characters / 3.6. Each capped reply has a budget,
 * so a change that starts sending bulk by default fails here rather than in
 * someone's context window. Set RESPONSE_SIZE_REPORT=1 to print the table.
 *
 * Capping never drops information silently: every cut says how much it cut
 * and how to read the rest, which the tests below also hold.
 */
import { describe, expect, it } from 'bun:test';
import { handleBuilddAction, type ActionContext, type ApiFn } from '../mcp-tools';

const WS = '00000000-0000-0000-0000-000000000001';
const WORKER = '00000000-0000-0000-0000-000000000002';
const TASK = '00000000-0000-0000-0000-000000000003';
const MISSION = '00000000-0000-0000-0000-000000000004';

const tokens = (s: string) => Math.ceil(s.length / 3.6);
const id = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const lorem = (n: number) => {
  const base = 'The worker reads the claim, edits the handler, runs the tests and opens the PR against the integration branch. ';
  return base.repeat(Math.ceil(n / base.length)).slice(0, n);
};

function ctx(overrides: Partial<ActionContext> = {}): ActionContext {
  return {
    workspaceId: WS,
    getWorkspaceId: async () => WS,
    getLevel: async () => 'admin',
    ...overrides,
  };
}

/** A fake API that answers each path prefix with its fixture. */
function apiFor(routes: Array<[RegExp, unknown]>): ApiFn {
  return (async (path: string) => {
    for (const [re, body] of routes) if (re.test(path)) return typeof body === 'function' ? (body as (p: string) => unknown)(path) : body;
    throw new Error(`unexpected path ${path}`);
  }) as unknown as ApiFn;
}

async function reply(api: ApiFn, action: string, params: Record<string, unknown>, c: ActionContext = ctx()): Promise<string> {
  const r = await handleBuilddAction(api, action, params, c);
  return r.content.map(x => ('text' in x ? x.text : '')).join('\n');
}

// ── fixtures ────────────────────────────────────────────────────────────────

const LONG_DESCRIPTION = `## Goal\n${lorem(2600)}\n\n## Policy\n${lorem(900)}`;

function workerRow(n: number) {
  return {
    id: id(100 + n), status: n === 0 ? 'running' : 'failed', branch: `buildd/0000000${n}-fix-thing`,
    currentAction: n === 0 ? 'Running tests' : null, prUrl: n < 2 ? `https://github.com/acme/app/pull/${4000 + n}` : null,
    prNumber: n < 2 ? 4000 + n : null, lastCommitSha: 'abcdef1234567890', completedAt: n === 0 ? null : '2026-10-01T00:00:00.000Z',
    error: n === 0 ? null : `Stale worker expired (no update for 15+ minutes) after ${lorem(120)}`,
  };
}

const TASK_ROW = {
  id: TASK, title: 'fix(api): a claim that outruns its ack keeps its wake', status: 'in_progress', category: 'bug', priority: 5,
  kind: 'engineering', roleSlug: 'builder', description: LONG_DESCRIPTION,
  workspace: { name: 'app', repo: 'https://github.com/acme/app' },
  mission: { id: MISSION, title: 'Delivery reliability', status: 'active' },
  loopConfig: { maxLoops: 6, exitCondition: { type: 'command', command: 'bun run test' } }, loopIteration: 7,
  result: {
    loopHistory: Array.from({ length: 8 }, (_, i) => ({ iteration: i, satisfied: false, conditionType: 'command', summary: `Iteration ${i}: 3 tests failing`, evidence: { durationMs: 41000, output: lorem(600) } })),
  },
  workers: Array.from({ length: 7 }, (_, i) => workerRow(i)),
  artifacts: Array.from({ length: 14 }, (_, i) => ({ id: id(300 + i), title: `Screenshot ${i}`, type: 'screenshot', key: null, shareUrl: `https://app.example/share/${i}` })),
};

const OPEN_PRS = [
  { prNumber: 4101, branch: 'buildd/aaaa0001-claims', prUrl: 'https://github.com/acme/app/pull/4101', taskTitle: 'feat(claim): over-fetch the claim window', pathManifest: ['apps/web/src/app/api/workers/claim/route.ts'] },
  // The same PR again under its review task's title.
  { prNumber: 4101, branch: 'buildd/aaaa0001-claims', prUrl: 'https://github.com/acme/app/pull/4101', taskTitle: '[review] feat(claim): over-fetch the claim window', pathManifest: null },
  ...Array.from({ length: 8 }, (_, i) => ({
    prNumber: 4110 + i, branch: `buildd/bbbb000${i}-other`, prUrl: `https://github.com/acme/app/pull/${4110 + i}`,
    taskTitle: `chore(ui): unrelated change number ${i} with a long descriptive title`, pathManifest: [`apps/web/src/components/thing-${i}.tsx`],
  })),
];

const CLAIM = {
  workers: [{
    id: WORKER, taskId: TASK, branch: 'buildd/00000003-fix-claim-ack',
    task: { ...TASK_ROW, workspaceId: WS, pathManifest: ['apps/web/src/app/api/workers/claim/'] },
    openPRs: OPEN_PRS,
  }],
};

function explainAnswer(n: number) {
  const ref = { taskId: id(500 + n), prNumber: 4200 + n, sha: 'abcdef1234567890abcdef1234567890abcdef12' };
  return {
    subject: { scope: 'task', id: id(500 + n), label: `Task ${n}: ${lorem(60)}`, workspaceId: WS, missionId: MISSION, taskId: id(500 + n), prNumber: null },
    state: 'blocked', displayState: 'blocked', chip: { tone: 'warn', label: 'Blocked' },
    waitingOn: { kind: n % 3 === 0 ? 'failed_task' : 'open_pr', label: `PR #${4200 + n} is red`, refs: ref },
    outstanding: [{ kind: 'open_pr', label: `PR #${4200 + n} is red`, refs: ref }, { kind: 'dependency', label: 'Waits on another task', refs: ref }],
    situation: { line: `Waiting on PR #${4200 + n}: CI failed on the unit job`, tone: 'warn' },
    because: Array.from({ length: 5 }, (_, i) => ({ order: i + 1, claim: `Link ${i}: ${lorem(140)}`, refs: ref, source: 'tasks.status' })),
    history: Array.from({ length: 6 }, (_, i) => ({ taskId: id(600 + i), title: `Attempt ${i}`, status: 'failed', at: '2026-10-01T00:00:00.000Z', retries: [], reviewPasses: [] })),
    nextAction: 'Read the failing CI log with get_pr includeCiFailures:true and fix the test.',
    gateHistory: Array.from({ length: 4 }, (_, i) => ({ gate: 'claim_deferred', reason: `deferred ${i}: ${lorem(80)}`, at: '2026-10-01T00:00:00.000Z', firstDeferredAt: null })),
    derivedFrom: { state: 'mission-state', waitingOn: 'mission-state', because: ['tasks.status', 'workers.prUrl'], history: 'tasks', nextAction: 'derived', gateHistory: 'gate_events' },
  };
}

const EXPLAIN_WORKSPACE = { scope: 'workspace', subjects: Array.from({ length: 40 }, (_, i) => explainAnswer(i)), considered: 120, quiet: 80 };
const EXPLAIN_TASK = { scope: 'task', subjects: [explainAnswer(1)] };

const PR = {
  pr: {
    number: 4101, title: 'feat(claim): over-fetch the claim window', state: 'open', mergeable: false, mergeableState: 'dirty',
    additions: 420, deletions: 80, changedFiles: 12, generatedFiles: 0, generatedAdditions: 0, generatedDeletions: 0,
    body: lorem(6000), url: 'https://github.com/acme/app/pull/4101',
  },
  checks: {
    total: 14, passed: 4, failed: 10, pending: 0, state: 'failure',
    failedChecks: Array.from({ length: 10 }, (_, i) => ({ name: `build / job ${i}`, url: `https://github.com/acme/app/actions/runs/1/job/${i}` })),
  },
  reviews: { approved: 0, changesRequested: 1 },
  attempts: Array.from({ length: 9 }, (_, i) => ({
    taskId: id(700 + i), title: `fix: after CI #${i + 1} ${lorem(60)}`, status: 'failed', prNumber: null,
    evidence: { errorClass: 'test_failure', keyLines: [lorem(200)] }, mismatch: [],
  })),
};

const TASK_LIST = {
  tasks: Array.from({ length: 5 }, (_, i) => ({ id: id(800 + i), title: `feat: task ${i} ${lorem(40)}`, status: i ? 'pending' : 'in_progress', category: 'feature', descriptionPreview: lorem(150) })),
  total: 37, pendingCount: 30, hasMore: true,
};

const MISSION_ROW = {
  id: MISSION, title: 'Delivery reliability', status: 'active', progress: 40, completedTasks: 24, totalTasks: 60,
  description: lorem(3000), orchestrationMode: 'auto', executor: 'runner',
  goalCriteria: [{ type: 'command', command: 'bun run test', label: 'tests pass' }, { type: 'all_prs_merged' }],
  goalCriteriaState: { overall: 'fail', evaluatedAt: '2026-10-01T00:00:00.000Z', criteria: [{ verdict: 'fail', label: 'tests pass', evidence: lorem(1500) }, { verdict: 'pass', label: 'all PRs merged', evidence: 'ok' }] },
  tasks: Array.from({ length: 60 }, (_, i) => ({ id: id(900 + i), title: `task ${i}: ${lorem(50)}`, status: i < 24 ? 'completed' : i < 30 ? 'in_progress' : 'pending' })),
};

const MISSION_LIST = {
  missions: Array.from({ length: 20 }, (_, i) => ({ id: id(1000 + i), title: `Mission ${i}`, status: 'active', progress: 30, completedTasks: 3, totalTasks: 10, workspace: { name: 'app' }, lastActivityAt: '2026-10-01T00:00:00.000Z', createdAt: '2026-09-01T00:00:00.000Z' })),
  total: 31,
};

const ARTIFACTS = { artifacts: Array.from({ length: 10 }, (_, i) => ({ id: id(1100 + i), title: `Report ${i}`, type: 'report', key: null, updatedAt: '2026-10-01T00:00:00.000Z', shareUrl: null, content: lorem(800) })) };
const ARTIFACT = { artifact: { id: id(1200), title: 'Report', type: 'report', createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', content: lorem(4000), metadata: {} } };

const FAILURE_LOOKUP = {
  analytics: { window: '7d', totals: { started: 110, terminal: 100, stillRunning: 10, completed: 70, failed: 30, failureRatePct: 30, diedEarly: 18, diedEarlySharePct: 60 }, byExitCause: [], signatures: [], diedEarlySignatures: [], byRole: [], byWorkspace: [], repeatFailureTasks: [] },
  lookup: { query: 'Stale worker expired', signature: 'Stale worker expired (no update for <n>+ minutes)', frictionSignature: 'worker-failure:stale_a1b2c3', known: true, count: 12, firstSeen: '2026-08-22T00:00:00.000Z', lastSeen: '2026-08-27T00:00:00.000Z', diedEarlyCount: 9, exitCauses: ['infra_failure'], exampleTaskId: 't1', exhaustive: true },
};

// ── the measured calls ──────────────────────────────────────────────────────

type Case = { name: string; budget: number; run: () => Promise<string> };

const CASES: Case[] = [
  { name: 'get_task', budget: 1400, run: () => reply(apiFor([[/^\/api\/tasks\//, TASK_ROW]]), 'get_task', { taskId: TASK }) },
  { name: 'claim_task', budget: 450, run: () => reply(apiFor([[/^\/api\/workers\/claim/, CLAIM]]), 'claim_task', {}) },
  { name: 'update_progress', budget: 60, run: () => reply(apiFor([[/^\/api\/workers\//, { ok: true }]]), 'update_progress', { workerId: WORKER, progress: 40, message: 'Tests written' }) },
  { name: 'create_pr', budget: 80, run: () => reply(apiFor([[/^\/api\/github\/pr$/, { pr: { number: 4101, title: 'feat: x', url: 'https://github.com/acme/app/pull/4101', state: 'open' } }], [/^\/api\/workers\//, { taskId: TASK }]]), 'create_pr', { workerId: WORKER, title: 'feat: x', head: 'buildd/x', lede: 'A thing now works.' }) },
  { name: 'list_tasks', budget: 500, run: () => reply(apiFor([[/^\/api\/tasks\?/, TASK_LIST]]), 'list_tasks', {}) },
  { name: 'get_pr', budget: 1350, run: () => reply(apiFor([[/^\/api\/github\/pr\?/, PR]]), 'get_pr', { prNumber: 4101 }) },
  { name: 'get_failure_analytics (error=)', budget: 150, run: () => reply(apiFor([[/^\/api\/health\/failures/, FAILURE_LOOKUP]]), 'get_failure_analytics', { error: 'Stale worker expired' }) },
  { name: 'explain (workspace)', budget: 2300, run: () => reply(apiFor([[/^\/api\/explain/, EXPLAIN_WORKSPACE]]), 'explain', { workspaceId: WS }) },
  { name: 'explain (task)', budget: 1450, run: () => reply(apiFor([[/^\/api\/explain/, EXPLAIN_TASK]]), 'explain', { taskId: TASK }) },
  { name: 'manage_missions get', budget: 1050, run: () => reply(apiFor([[/^\/api\/missions\//, MISSION_ROW]]), 'manage_missions', { action: 'get', missionId: MISSION }) },
  { name: 'manage_missions list', budget: 1200, run: () => reply(apiFor([[/^\/api\/missions\?/, MISSION_LIST]]), 'manage_missions', { action: 'list' }) },
  { name: 'list_artifacts', budget: 1050, run: () => reply(apiFor([[/\/artifacts\?/, ARTIFACTS]]), 'list_artifacts', { workspaceId: WS }) },
  { name: 'get_artifact', budget: 1250, run: () => reply(apiFor([[/^\/api\/artifacts\//, ARTIFACT]]), 'get_artifact', { artifactId: id(1200) }) },
];

describe('MCP response budgets (chars / 3.6)', () => {
  it('prints the size table when asked', async () => {
    if (!process.env.RESPONSE_SIZE_REPORT) return;
    const rows: string[] = [];
    for (const c of CASES) rows.push(`${c.name.padEnd(32)} ${String(tokens(await c.run())).padStart(7)} (budget ${c.budget})`);
    process.stderr.write(`\n${rows.join("\n")}\n`);
  });

  for (const c of CASES) {
    it(`${c.name} stays under ${c.budget} tokens`, async () => {
      expect(tokens(await c.run())).toBeLessThan(c.budget);
    });
  }
});

describe('capped replies say what they left out and how to read it', () => {
  it('claim_task: the description preview points at get_task fullDescription', async () => {
    const out = await reply(apiFor([[/^\/api\/workers\/claim/, CLAIM]]), 'claim_task', {});
    expect(out).toMatch(/…\[truncated \d+ chars\]/);
    expect(out).toContain(`get_task {taskId: "${TASK}", fullDescription: true}`);
    expect(out).not.toContain(lorem(2600));
  });

  it('claim_task: lists a PR once, only the ones touching the declared paths, and counts the rest', async () => {
    const out = await reply(apiFor([[/^\/api\/workers\/claim/, CLAIM]]), 'claim_task', {});
    expect(out.match(/PR #4101/g)?.length).toBe(1);
    expect(out).not.toContain('PR #4110');
    expect(out).toContain('8 other open PRs in this workspace touch none of your paths');
  });

  it('claim_task: with no declared paths, the newest few PRs and a count', async () => {
    const claim = { workers: [{ ...CLAIM.workers[0], task: { ...CLAIM.workers[0].task, pathManifest: null } }] };
    const out = await reply(apiFor([[/^\/api\/workers\/claim/, claim]]), 'claim_task', {});
    expect(out.match(/^- PR #/gm)?.length).toBe(3);
    expect(out).toContain('6 other open PRs in this workspace — list_prs lists them all.');
  });

  it('claim_task: the current-assignment shortcut uses the same compact form', async () => {
    const worker = { id: WORKER, status: 'running', branch: 'buildd/x', task: { id: TASK, title: 'T', description: LONG_DESCRIPTION, status: 'in_progress' } };
    const out = await reply(apiFor([[/^\/api\/workers\//, worker]]), 'claim_task', {}, ctx({ workerId: WORKER }));
    expect(out).toContain('Current assignment already active');
    expect(out).toContain('fullDescription: true');
    expect(out.length).toBeLessThan(1000);
  });

  it('explain on a workspace: one ranked page, the omitted count, and the call for each full answer', async () => {
    const out = JSON.parse(await reply(apiFor([[/^\/api\/explain/, EXPLAIN_WORKSPACE]]), 'explain', { workspaceId: WS }));
    expect(out.subjects).toHaveLength(5);
    expect(out).toMatchObject({ waiting: 40, shown: 5, omitted: 35, offset: 0, considered: 120, quiet: 80 });
    expect(out.subjects[0].subject.taskId).toBe(EXPLAIN_WORKSPACE.subjects[0].subject.taskId);
    expect(out.subjects[0].full).toBe(`explain {taskId: "${id(500)}"}`);
    expect(out.subjects[0].becauseOmitted).toBe(3);
    expect(out.more).toContain('offset: 5');
  });

  it('explain on a workspace: offset and limit page through the ranking', async () => {
    const out = JSON.parse(await reply(apiFor([[/^\/api\/explain/, EXPLAIN_WORKSPACE]]), 'explain', { workspaceId: WS, offset: 38, limit: 10 }));
    expect(out.subjects.map((s: any) => s.subject.taskId)).toEqual([id(538), id(539)]);
    expect(out.more).toContain('last page');
  });

  it('explain on one subject keeps the whole answer', async () => {
    const out = JSON.parse(await reply(apiFor([[/^\/api\/explain/, EXPLAIN_TASK]]), 'explain', { taskId: TASK }));
    expect(out).toEqual(EXPLAIN_TASK);
  });

  it('get_task: newest workers, artifacts and iterations, counted; all:true returns every one', async () => {
    const api = apiFor([[/^\/api\/tasks\//, TASK_ROW]]);
    const out = await reply(api, 'get_task', { taskId: TASK });
    expect(out).toContain('(4 older workers omitted — pass all:true for every one.)');
    expect(out).toContain('(4 more not shown — pass all:true, or list_artifacts.)');
    expect(out).toContain('(3 earlier iterations omitted');
    expect(out).not.toContain('Worker URL');
    const all = await reply(api, 'get_task', { taskId: TASK, all: true });
    for (const w of TASK_ROW.workers) expect(all).toContain(w.id);
    for (const a of TASK_ROW.artifacts) expect(all).toContain(a.id);
    expect(all).not.toContain('omitted');
  });

  it('get_pr: first failing checks and latest attempts, counted; all:true returns every one', async () => {
    const api = apiFor([[/^\/api\/github\/pr\?/, PR]]);
    const out = await reply(api, 'get_pr', { prNumber: 4101 });
    expect(out).toContain('(+5 more — all:true lists every one)');
    expect(out).toContain('(4 earlier attempts omitted');
    expect(out).toContain(PR.attempts[8].taskId.slice(0, 8));
    const all = await reply(api, 'get_pr', { prNumber: 4101, all: true });
    for (const c of PR.checks.failedChecks) expect(all).toContain(c.name);
    for (const a of PR.attempts) expect(all).toContain(a.taskId.slice(0, 8));
  });

  it('manage_missions get: unfinished tasks first, counted by status; all:true returns every one', async () => {
    const api = apiFor([[/^\/api\/missions\//, MISSION_ROW]]);
    const out = await reply(api, 'manage_missions', { action: 'get', missionId: MISSION });
    expect(out).toContain('(45 more: 21 pending, 24 completed — all:true, or list_tasks {missionId, status})');
    expect(out).toContain('fullDescription:true for all of it');
    expect(out).toContain('Full evidence: action=get_criteria_state');
    const all = await reply(api, 'manage_missions', { action: 'get', missionId: MISSION, all: true });
    for (const t of MISSION_ROW.tasks) expect(all).toContain(t.id);
    expect(all).toContain(MISSION_ROW.description);
  });
});
