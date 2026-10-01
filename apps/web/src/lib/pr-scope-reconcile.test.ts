/**
 * PR-backed scope reconciliation (conflict-aware-orchestration §1, Step B).
 *
 * The read is tested against a scripted GitHub; the narrowing plan is pure;
 * the orchestration runs against a mocked db whose WHERE clauses are rendered
 * through PgDialect so workspace and PR scoping are asserted, not assumed.
 */
import { describe, it, expect, mock, beforeEach } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';

const WS = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OWNER = '11111111-1111-4111-8111-111111111111';
const FIX = '22222222-2222-4222-8222-222222222222';
const REVIEW = '33333333-3333-4333-8333-333333333333';
const REPO = 'acme/widgets';
const PR = 42;

const calls = {
  workersFindMany: [] as any[],
  tasksFindMany: [] as any[],
  claimsFindMany: [] as any[],
  updates: [] as Array<{ set: any; where: any }>,
};
let prWorkerRows: any[] = [];
let taskRows: any[] = [];
let liveWorkerRows: any[] = [];
let leaseRows: any[] = [];
let restoreRows: any[] = [{ revision: 6 }];

const workersFindMany = mock(async (opts: any) => {
  calls.workersFindMany.push(opts);
  return calls.workersFindMany.length === 1 ? prWorkerRows : liveWorkerRows;
});
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      workers: { findMany: workersFindMany },
      tasks: { findMany: async (opts: any) => { calls.tasksFindMany.push(opts); return taskRows; } },
      pathClaims: { findMany: async (opts: any) => { calls.claimsFindMany.push(opts); return leaseRows; } },
    },
    update: () => ({
      set: (set: any) => ({
        where: (where: any) => {
          const entry = { set, where };
          const done = Promise.resolve().then(() => { calls.updates.push(entry); });
          return Object.assign(done, {
            // A CAS update (restore) asks for the new revision back.
            returning: async () => {
              await done;
              (entry as any).cas = true;
              return restoreRows;
            },
          });
        },
      }),
    }),
  },
}));

const mockNarrow = mock(async (input: any) => ({
  kind: 'narrowed', workspaceId: input.workspaceId, pathManifest: [], revision: input.expectedRevision + 1,
  releasedPaths: [], notifiedWaiters: [], waiters: [],
}) as any);
mock.module('@buildd/core/path-claim', () => ({ narrowPathClaims: mockNarrow }));
const mockDeliver = mock(async () => {});
mock.module('@/lib/path-claim-release', () => ({ deliverPathReleased: mockDeliver }));

const {
  readPinnedPrScope, planScopeNarrowing, reconcilePrBackedScope, scopeHolderTasksWhere,
  PR_FILES_PAGE_SIZE,
} = await import('./pr-scope-reconcile');

const dialect = new PgDialect();
const render = (q: any) => dialect.sqlToQuery(q);

// ── Scripted GitHub ──────────────────────────────────────────────────────────

const files = (n: number, prefix = 'src/f') => Array.from({ length: n }, (_, i) => ({ filename: `${prefix}${i}.ts` }));
const pr = (over: Record<string, any> = {}) => ({
  state: 'open', merged: false, head: { sha: 'head1aaaaaaa' }, base: { sha: 'base1bbbbbbb' }, changed_files: 2, ...over,
});

function scripted(opts: { prs: any[]; pages: any[][] }) {
  const prs = [...opts.prs];
  const paths: string[] = [];
  const get = async (path: string) => {
    paths.push(path);
    if (path.includes('/files')) {
      const page = Number(new URL(`https://x${path}`).searchParams.get('page'));
      return opts.pages[page - 1] ?? [];
    }
    const next = prs.length > 1 ? prs.shift() : prs[0];
    if (next instanceof Error) throw next;
    return next;
  };
  return { get, paths };
}

describe('readPinnedPrScope', () => {
  it('reads every page, including an exactly-full last page', async () => {
    const pages = [files(100, 'a/'), files(100, 'b/'), files(37, 'c/')];
    const gh = scripted({ prs: [pr({ changed_files: 237 })], pages });
    const read = await readPinnedPrScope(gh.get, { repoFullName: REPO, prNumber: PR });
    expect(read.status).toBe('complete');
    if (read.status !== 'complete') return;
    expect(read.files).toHaveLength(237);
    expect(gh.paths.filter(p => p.includes('/files'))).toHaveLength(3);
    expect(gh.paths.every(p => !p.includes('/files') || p.includes(`per_page=${PR_FILES_PAGE_SIZE}`))).toBe(true);

    const full = scripted({ prs: [pr({ changed_files: 200 })], pages: [files(100, 'a/'), files(100, 'b/')] });
    const r2 = await readPinnedPrScope(full.get, { repoFullName: REPO, prNumber: PR });
    expect(r2.status).toBe('complete');
    // A full page means "maybe more": the empty third page is what ends it.
    expect(full.paths.filter(p => p.includes('/files'))).toHaveLength(3);
  });

  it('includes both sides of a rename', async () => {
    const gh = scripted({
      prs: [pr()],
      pages: [[{ filename: 'new/name.ts', previous_filename: 'old/name.ts', status: 'renamed' }, { filename: 'x.ts' }]],
    });
    const read = await readPinnedPrScope(gh.get, { repoFullName: REPO, prNumber: PR });
    expect(read.status === 'complete' && read.files).toEqual(['new/name.ts', 'old/name.ts', 'x.ts']);
  });

  it('refuses a list shorter than changed_files (truncated)', async () => {
    const gh = scripted({ prs: [pr({ changed_files: 5 })], pages: [files(2)] });
    const read = await readPinnedPrScope(gh.get, { repoFullName: REPO, prNumber: PR });
    expect(read.status).toBe('incomplete');
    expect(read.status === 'incomplete' && read.reason).toBe('truncated');
  });

  it('refuses a read whose head moved mid-read', async () => {
    const gh = scripted({ prs: [pr(), pr({ head: { sha: 'head2ccccccc' } })], pages: [files(2)] });
    const read = await readPinnedPrScope(gh.get, { repoFullName: REPO, prNumber: PR });
    expect(read.status === 'incomplete' && read.reason).toBe('head_moved');
  });

  it('refuses a read whose base moved mid-read', async () => {
    const gh = scripted({ prs: [pr(), pr({ base: { sha: 'base2ddddddd' } })], pages: [files(2)] });
    const read = await readPinnedPrScope(gh.get, { repoFullName: REPO, prNumber: PR });
    expect(read.status === 'incomplete' && read.reason).toBe('base_moved');
  });

  it('refuses a head other than the one the caller saw', async () => {
    const gh = scripted({ prs: [pr()], pages: [files(2)] });
    const read = await readPinnedPrScope(gh.get, { repoFullName: REPO, prNumber: PR, expectedHeadSha: 'otherheadsha' });
    expect(read.status === 'incomplete' && read.reason).toBe('head_moved');
    expect(gh.paths.some(p => p.includes('/files'))).toBe(false);
  });

  it('treats a failed page as incomplete, never as an empty diff', async () => {
    const get = async (path: string) => {
      if (path.includes('/files')) throw new Error('GitHub API error: 502');
      return pr();
    };
    const read = await readPinnedPrScope(get, { repoFullName: REPO, prNumber: PR });
    expect(read.status === 'incomplete' && read.reason).toBe('read_failed');
  });

  it('reports a PR closed before or during the read', async () => {
    const closed = scripted({ prs: [pr({ state: 'closed' })], pages: [files(2)] });
    expect((await readPinnedPrScope(closed.get, { repoFullName: REPO, prNumber: PR })).status).toBe('closed');
    const during = scripted({ prs: [pr(), pr({ state: 'closed' })], pages: [files(2)] });
    expect((await readPinnedPrScope(during.get, { repoFullName: REPO, prNumber: PR })).status).toBe('closed');
  });
});

// ── Planning ─────────────────────────────────────────────────────────────────

const complete = (paths: string[]) => ({ status: 'complete' as const, files: paths, headSha: 'h', baseSha: 'b' });
const holder = (over: Record<string, any> = {}) => ({
  taskId: FIX, role: 'fix_attempt' as const, pathManifest: null, revision: 3, heldLeases: [], liveEdits: null, priorDrops: [], ...over,
});

describe('planScopeNarrowing', () => {
  it('shrinks a stale branch-wide manifest to the small actual diff', () => {
    const stale = [...files(40, 'apps/web/src/lib/x').map(f => f.filename), 'packages/core/a.ts', 'packages/core/b.ts'];
    const plan = planScopeNarrowing(holder({ pathManifest: stale, heldLeases: ['apps/web/src/lib/x7.ts'] }), complete(['packages/core/a.ts', 'packages/core/b.ts']));
    expect(plan.drop).toHaveLength(40);
    expect(plan.drop).not.toContain('packages/core/a.ts');
    expect(plan.drop).toContain('apps/web/src/lib/x7.ts');
  });

  it('keeps a directory entry that contains a changed file, and never drops the sentinel', () => {
    const plan = planScopeNarrowing(holder({ pathManifest: ['**', 'packages/core/', 'docs/a.md'] }), complete(['packages/core/a.ts']));
    expect(plan.drop).toEqual(['docs/a.md']);
  });

  it('protects a live writer: leases and touched paths stay, only untouched inherited entries go', () => {
    const plan = planScopeNarrowing(holder({
      pathManifest: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
      heldLeases: ['b.ts', 'e.ts'],
      liveEdits: ['c.ts'],
    }), complete(['a.ts']));
    expect(plan.drop).toEqual(['d.ts']);
    expect(plan.drop).not.toContain('e.ts');
  });

  it('does not narrow the PR owner while its worker is live, even uncommitted, unleased entries', () => {
    const plan = planScopeNarrowing(holder({
      role: 'pr_owner',
      pathManifest: ['a.ts', 'b.ts', 'scratch.sh'],
      heldLeases: [],
      liveEdits: [],
    }), complete(['a.ts']));
    expect(plan.drop).toEqual([]);
    expect(plan.liveWriter).toBe(true);
    // A fix attempt that inherited the same manifest is still narrowed while live.
    const fix = planScopeNarrowing(holder({ pathManifest: ['a.ts', 'b.ts'], liveEdits: [] }), complete(['a.ts']));
    expect(fix.drop).toEqual(['b.ts']);
    expect(fix.liveWriter).toBe(false);
  });

  it('restores a path an earlier reconciliation dropped once a complete read shows it in the diff', () => {
    const plan = planScopeNarrowing(holder({
      role: 'pr_owner',
      pathManifest: ['a.ts'],
      priorDrops: ['b.ts', 'lib/', 'gone.ts', 'a.ts'],
    }), complete(['a.ts', 'b.ts', 'lib/x.ts']));
    // Directory drops come back whole; paths still outside the diff stay dropped;
    // a path the manifest already covers is not appended twice.
    expect(plan.restore.sort()).toEqual(['b.ts', 'lib']);
    expect(plan.drop).toEqual([]);
  });

  it('restores nothing from an unusable read, to a reviewer, or to an undeclared manifest', () => {
    const prior = { priorDrops: ['b.ts'] };
    expect(planScopeNarrowing(holder({ pathManifest: ['a.ts'], ...prior }), {
      status: 'incomplete', reason: 'head_moved', detail: 'x', headSha: 'h', baseSha: 'b',
    }).restore).toEqual([]);
    expect(planScopeNarrowing(holder({ role: 'reviewer', pathManifest: ['a.ts'], ...prior }), complete(['b.ts'])).restore).toEqual([]);
    expect(planScopeNarrowing(holder({ pathManifest: null, ...prior }), complete(['b.ts'])).restore).toEqual([]);
  });

  it('drops nothing on an unusable read', () => {
    const plan = planScopeNarrowing(holder({ pathManifest: ['a.ts', 'z.ts'] }), {
      status: 'incomplete', reason: 'truncated', detail: 'listed 2 of 5', headSha: 'h', baseSha: 'b',
    });
    expect(plan.drop).toEqual([]);
    expect(plan.skipReason).toContain('truncated');
    expect(planScopeNarrowing(holder({ pathManifest: ['z.ts'] }), { status: 'closed', merged: false, headSha: null, baseSha: null }).drop).toEqual([]);
  });

  it('a read-only reviewer gives back every lease, even without a usable read', () => {
    const plan = planScopeNarrowing(holder({ role: 'reviewer', heldLeases: ['a.ts', 'b.ts'], liveEdits: ['a.ts'] }), {
      status: 'incomplete', reason: 'read_failed', detail: 'x', headSha: null, baseSha: null,
    });
    expect(plan.drop.sort()).toEqual(['a.ts', 'b.ts']);
  });
});

// ── Orchestration ────────────────────────────────────────────────────────────

const taskRow = (id: string, over: Record<string, any> = {}) => ({
  id, category: null, context: null, pathManifest: null, pathDeclaration: null, pathClaimRevision: 0,
  conflictRetryPrNumber: null, reviewerRetryPrNumber: null, ciRetryPrNumber: null, ...over,
});

describe('reconcilePrBackedScope', () => {
  beforeEach(() => {
    calls.workersFindMany = []; calls.tasksFindMany = []; calls.claimsFindMany = []; calls.updates = [];
    mockNarrow.mockClear(); mockDeliver.mockClear();
    prWorkerRows = [{ taskId: OWNER }, { taskId: FIX }];
    taskRows = [
      taskRow(OWNER, { pathManifest: ['a.ts', 'stale1.ts', 'stale2.ts'], pathClaimRevision: 5 }),
      taskRow(FIX, { pathManifest: ['a.ts', 'stale1.ts'], reviewerRetryPrNumber: PR, pathClaimRevision: 2 }),
      taskRow(REVIEW, { category: 'review', context: { reviewerFor: OWNER, prNumber: PR } }),
    ];
    liveWorkerRows = [{ taskId: REVIEW, observedTouches: ['a.ts'] }];
    leaseRows = [{ taskId: REVIEW, path: 'a.ts' }, { taskId: FIX, path: 'stale1.ts' }];
    restoreRows = [{ revision: 6 }];
  });

  it('narrows the open-PR owner, the fix attempt and the reviewer, each under its own revision', async () => {
    const gh = scripted({ prs: [pr({ changed_files: 1 })], pages: [[{ filename: 'a.ts' }]] });
    const report = await reconcilePrBackedScope({ workspaceId: WS, repoFullName: REPO, prNumber: PR, get: gh.get });

    expect(report.read).toBe('complete');
    const byTask = Object.fromEntries(mockNarrow.mock.calls.map(([i]: any) => [i.taskId, i]));
    expect(byTask[OWNER].paths.sort()).toEqual(['stale1.ts', 'stale2.ts']);
    expect(byTask[OWNER].expectedRevision).toBe(5);
    expect(byTask[FIX].paths).toEqual(['stale1.ts']);
    expect(byTask[FIX].expectedRevision).toBe(2);
    expect(byTask[REVIEW].paths).toEqual(['a.ts']);
    for (const i of Object.values(byTask) as any[]) expect(i.workspaceId).toBe(WS);
    expect(mockDeliver).toHaveBeenCalledTimes(3);
    // Every holder gets the outcome recorded on its declaration.
    expect(calls.updates).toHaveLength(3);
    const recorded = render(calls.updates[0].set.pathDeclaration);
    expect(recorded.sql).toContain("'prScope'");
  });

  it('on a failed read narrows no editor, still releases the reviewer, and records why', async () => {
    const get = async (path: string) => { if (path.includes('/files')) throw new Error('boom'); return pr(); };
    const report = await reconcilePrBackedScope({ workspaceId: WS, repoFullName: REPO, prNumber: PR, get });
    expect(mockNarrow.mock.calls.map(([i]: any) => i.taskId)).toEqual([REVIEW]);
    const owner = report.tasks.find(t => t.taskId === OWNER)!;
    expect(owner.status).toBe('incomplete');
    expect(owner.reason).toContain('read_failed');
    const params = render(calls.updates[0].set.pathDeclaration).params;
    expect(params.some((p: unknown) => typeof p === 'string' && p.includes('read_failed'))).toBe(true);
  });

  it('leaves a live PR owner untouched and records live_writer', async () => {
    liveWorkerRows = [{ taskId: OWNER, observedTouches: [] }, { taskId: FIX, observedTouches: [] }];
    leaseRows = [];
    const gh = scripted({ prs: [pr({ changed_files: 1 })], pages: [[{ filename: 'a.ts' }]] });
    const report = await reconcilePrBackedScope({ workspaceId: WS, repoFullName: REPO, prNumber: PR, get: gh.get });

    const narrowed = mockNarrow.mock.calls.map(([i]: any) => i.taskId);
    expect(narrowed).not.toContain(OWNER);
    // The live fix attempt's inherited entries still go.
    expect(narrowed).toContain(FIX);
    const owner = report.tasks.find(t => t.taskId === OWNER)!;
    expect(owner.status).toBe('live_writer');
    expect(owner.dropped).toEqual([]);
    const ownerRecord = calls.updates.find(u => render(u.where).params.includes(OWNER))!;
    const params = render(ownerRecord.set.pathDeclaration).params;
    expect(params.some((p: unknown) => typeof p === 'string' && p.includes('"live_writer"'))).toBe(true);
  });

  it('restores a path a racing read dropped when the next complete read finds it', async () => {
    // First pass: GitHub lagged behind a push, so the read did not show b.ts yet.
    taskRows = [taskRow(OWNER, {
      pathManifest: ['a.ts'],
      pathClaimRevision: 5,
      pathDeclaration: {
        declared: ['a.ts', 'b.ts'], source: 'creation', snapshotAt: 't',
        narrowings: [
          { at: 't', dropped: ['b.ts'], surface: 'pr-scope-reconcile', reason: 'outside PR #42 diff at head1aa' },
          { at: 't', dropped: ['c.ts'], surface: 'mcp:check_path_claim', reason: 'agent gave it back' },
        ],
      },
    })];
    prWorkerRows = [{ taskId: OWNER }];
    liveWorkerRows = []; leaseRows = [];
    const gh = scripted({ prs: [pr({ changed_files: 3 })], pages: [[{ filename: 'a.ts' }, { filename: 'b.ts' }, { filename: 'c.ts' }]] });
    const report = await reconcilePrBackedScope({ workspaceId: WS, repoFullName: REPO, prNumber: PR, get: gh.get });

    const owner = report.tasks.find(t => t.taskId === OWNER)!;
    // Only what this reconciler took away comes back; an agent's own give-back stays given.
    expect(owner.restored).toEqual(['b.ts']);
    const cas = calls.updates.find(u => (u as any).cas)!;
    expect(cas).toBeDefined();
    const where = render(cas.where);
    expect(where.sql).toContain('"tasks"."workspace_id" = $');
    expect(where.sql).toContain('"tasks"."path_claim_revision" = $');
    expect(where.params).toEqual(expect.arrayContaining([OWNER, WS, 5]));
    const set = render(cas.set.pathManifest);
    expect(set.params.some((p: unknown) => typeof p === 'string' && p.includes('b.ts'))).toBe(true);
    expect(set.params.some((p: unknown) => typeof p === 'string' && p.includes('c.ts'))).toBe(false);
  });

  it('a restore that loses the revision race restores nothing and says so', async () => {
    restoreRows = [];
    taskRows = [taskRow(OWNER, {
      pathManifest: ['a.ts'], pathClaimRevision: 5,
      pathDeclaration: { prScope: { prNumber: PR, status: 'complete', dropped: ['b.ts'] } },
    })];
    prWorkerRows = [{ taskId: OWNER }];
    liveWorkerRows = []; leaseRows = [];
    const gh = scripted({ prs: [pr({ changed_files: 2 })], pages: [[{ filename: 'a.ts' }, { filename: 'b.ts' }]] });
    const report = await reconcilePrBackedScope({ workspaceId: WS, repoFullName: REPO, prNumber: PR, get: gh.get });
    const owner = report.tasks.find(t => t.taskId === OWNER)!;
    expect(owner.restored).toEqual([]);
    expect(owner.status).toBe('revision_conflict');
    restoreRows = [{ revision: 6 }];
  });

  it('records a revision conflict and keeps the scope', async () => {
    mockNarrow.mockImplementationOnce(async () => ({ kind: 'revision_conflict', currentRevision: 9 }) as any);
    const gh = scripted({ prs: [pr({ changed_files: 1 })], pages: [[{ filename: 'a.ts' }]] });
    const report = await reconcilePrBackedScope({ workspaceId: WS, repoFullName: REPO, prNumber: PR, get: gh.get });
    const first = report.tasks.find(t => t.taskId === OWNER)!;
    expect(first.status).toBe('revision_conflict');
    expect(first.dropped).toEqual([]);
  });

  it('skips the GitHub read when nothing holds scope for the PR', async () => {
    prWorkerRows = []; taskRows = [];
    let reads = 0;
    const report = await reconcilePrBackedScope({ workspaceId: WS, repoFullName: REPO, prNumber: PR, get: async () => { reads++; return pr(); } });
    expect(report.read).toBe('skipped');
    expect(reads).toBe(0);
  });

  it('scopes every query to the workspace and the PR', async () => {
    const gh = scripted({ prs: [pr({ changed_files: 1 })], pages: [[{ filename: 'a.ts' }]] });
    await reconcilePrBackedScope({ workspaceId: WS, repoFullName: REPO, prNumber: PR, get: gh.get });

    const owners = render(calls.workersFindMany[0].where);
    expect(owners.sql).toContain('"workers"."workspace_id" = $');
    expect(owners.sql).toContain('"workers"."pr_number" = $');
    expect(owners.sql).toContain('"workers"."pr_url" = $');
    expect(owners.params).toContain(WS);
    expect(owners.params).toContain(`https://github.com/${REPO}/pull/${PR}`);

    const live = render(calls.workersFindMany[1].where);
    expect(live.sql).toContain('"workers"."status" in');
    expect(live.params).toEqual(expect.arrayContaining(['running', 'idle', 'starting', 'waiting_input']));
    expect(live.params).not.toContain('completed');

    const leases = render(calls.claimsFindMany[0].where);
    expect(leases.sql).toContain('"path_claims"."workspace_id" = $');
    expect(leases.sql).toContain('"path_claims"."released_at" is null');

    for (const u of calls.updates) {
      const w = render(u.where);
      expect(w.sql).toContain('"tasks"."workspace_id" = $');
      expect(w.params).toContain(WS);
    }
  });
});

describe('scopeHolderTasksWhere', () => {
  it('owners by id; attempts only while open and only for this PR', () => {
    const { sql, params } = render(scopeHolderTasksWhere(WS, PR, [OWNER]));
    expect(sql).toMatch(/^\("tasks"\."workspace_id" = \$1 and/);
    expect(sql).toContain('"tasks"."id" in');
    expect(sql).toContain('"tasks"."status" in');
    for (const col of ['conflict_retry_pr_number', 'reviewer_retry_pr_number', 'ci_retry_pr_number']) {
      expect(sql).toContain(`"tasks"."${col}" = $`);
    }
    expect(sql).toContain(`"tasks"."context"->>'prNumber' = $`);
    expect(params).toEqual(expect.arrayContaining([WS, OWNER, PR, String(PR), 'pending', 'assigned', 'in_progress']));
    expect(params).not.toContain('completed');
  });

  it('without known owners, still requires the workspace', () => {
    const { sql } = render(scopeHolderTasksWhere(WS, PR, []));
    expect(sql).toMatch(/^\("tasks"\."workspace_id" = \$1 and/);
    expect(sql).not.toContain('"tasks"."id" in');
  });
});
