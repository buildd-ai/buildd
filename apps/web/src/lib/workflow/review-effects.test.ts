/**
 * The review loop's host halves (review-effects.ts): the reviewer and fix task
 * rows `Work` files, the composition attestation, the records only the host
 * keeps. The handlers that call them are the package's, proven by the
 * conformance scenarios on both stores (packages/workflow-kernel/src/
 * conformance/scenarios.ts, `handlers/review`); the whole loop runs on real
 * Postgres in apps/web/tests/db/workflow-seam.test.ts. Legacy helpers are stubbed.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { KernelView } from './types';
import { capturedWhere } from '@buildd/core/db/relational-sql';

let view: KernelView;
const applied: any[] = [];
const ingested: any[] = [];
const executed: string[] = [];
/** Rows `db.execute` answers with: a follow-up insert that wrote a row returns one. */
let executeRows: unknown[] = [];
const inserted: any[] = [];
const notes: any[] = [];
let existingTask: { id: string } | null = null;
/** The status of the task a status-only read finds (an adopted reviewer). */
let adoptedStatus: string | null = 'running';
let missionRow: any = null;
let ownerRow: any = { id: 'owner-1', title: 'Fix the thing', description: 'd', missionId: 'm1', pathManifest: ['a.ts'], backend: 'claude', context: {} };
let reviewerResult: any = { structuredOutput: { verdict: 'request-changes', confidence: 0.9, summary: 's', feedback: 'check the caller task' } };
let livePr: any = { state: 'open', merged: false, headSha: 'H1', headRepoFullName: 'acme/w', baseRef: 'dev' };
let roles: any[] = [{ slug: 'reviewer' }];
const workerQueries: any[] = [];
let created: any = { id: 'reviewer-2' };
let postResult: any = { posted: true };

mock.module('./facts', () => ({ ingestFact: async (f: any) => { ingested.push(f); return { result: 'applied' }; } }));
mock.module('./github-facts', () => ({
  githubReader: () => ({ readPr: async () => livePr, contains: async () => true }),
  workspaceRepo: async () => ({ installationId: 1, repoFullName: 'acme/w', gitConfig: null }),
}));
const chain = (rows: any[] = []) => ({ where: () => ({ returning: async () => rows }) });
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      tasks: {
        findFirst: async (o: any) => {
          const cols = Object.keys(o?.columns ?? {});
          if (cols.length === 1 && cols[0] === 'result') return { result: reviewerResult };
          if (cols.length === 1 && cols[0] === 'id') return existingTask;
          if (cols.length === 1 && cols[0] === 'status') return adoptedStatus === null ? null : { status: adoptedStatus };
          if (cols.length === 1 && cols[0] === 'missionId') return { missionId: ownerRow.missionId };
          return ownerRow;
        },
      },
      workers: { findFirst: async (o: any) => { workerQueries.push(o); return ({ id: 'w1', branch: 'feat/x', prUrl: 'https://github.com/acme/w/pull/7', prBaseRef: 'dev', lastCommitSha: 'H1' }); } },
      workspaces: { findFirst: async () => ({ id: 'ws1', teamId: 'team1', gitConfig: null, releaseConfig: workspaceReleaseConfig }) },
      missions: { findFirst: async () => missionRow },
    },
    insert: (table: any) => ({
      values: (v: any) => {
        if (table === 'missionNotes') { notes.push(v); return Promise.resolve(); }
        inserted.push(v);
        return { onConflictDoNothing: () => ({ returning: async () => [{ id: v.id, title: v.title }] }) };
      },
    }),
    update: () => ({ set: () => chain([]) }),
    execute: async (q: any) => { executed.push(JSON.stringify(q.queryChunks?.map((c: any) => c.value ?? '').flat())); return { rows: executeRows }; },
  },
}));
mock.module('@buildd/core/db/schema', () => ({
  missionNotes: 'missionNotes', missions: 'missions', tasks: new Proxy({}, { get: (_t, k) => `tasks.${String(k)}` }),
  workers: new Proxy({}, { get: (_t, k) => `workers.${String(k)}` }), workspaces: new Proxy({}, { get: (_t, k) => `workspaces.${String(k)}` }),
}));
const mockPostPrReview = mock(async (_p: any) => postResult);
/** Composed-PR reads for the §5.9 check; default: GitHub unreadable (the check falls through). */
let ghApi: (path: string) => unknown = (path) => { throw new Error(`no fake GitHub for ${path}`); };
let workspaceReleaseConfig: unknown = null;
const ghCalls: string[] = [];
mock.module('@/lib/github', () => ({ postPrReview: mockPostPrReview, githubApi: async (_i: number, path: string) => { ghCalls.push(path); return ghApi(path); } }));
mock.module('@/lib/notify', () => ({ notifyTeamOf: mock(async () => undefined) }));
const mockAppend = mock(async (_p: any) => ({ action: 'created' }));
mock.module('@/lib/pr-activity-comment', () => ({ appendPrActivity: mockAppend, taskActivityUrl: (id: string) => `u/${id}` }));
const mockWake = mock(async (..._a: any[]) => undefined);
mock.module('@/lib/dispatch-authority', () => ({ announceTaskCreated: mock(async () => undefined), wakeTask: mockWake }));
mock.module('@/lib/merge-policy', () => ({ resolvePolicy: () => ({ tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } }), RESOLVE_POLICY_MISSION_COLUMNS: {} }));
mock.module('@/lib/pr-review-request', () => ({ listWorkspaceRoles: async () => roles }));
mock.module('@/lib/pr-review-status', () => ({ pickReviewerRole: (p: any) => ({ role: p.available[0]?.slug ?? null }) }));
mock.module('@/lib/path-declaration', () => ({ conformanceManifest: (t: any) => t.pathManifest ?? null }));
mock.module('@/lib/dependency-bot-pr', () => ({ isDependencyBotPrContext: (c: any) => !!c?.dependencyBot }));
mock.module('@/lib/pr-scope-reconcile-trigger', () => ({ schedulePrScopeReconcile: () => {} }));
const mockCreateReviewer = mock(async (_p: any) => created);
const mockSupersedeFix = mock(async (_p: any) => ({ superseded: true }));
mock.module('@/lib/reviewer', () => ({ createReviewerTask: mockCreateReviewer, supersedeFixTaskOnApproval: mockSupersedeFix }));
const mockEscalateExhaustion = mock(async (..._a: any[]) => undefined);
mock.module('@/lib/auto-merge', () => ({ escalateReviewerExhaustion: mockEscalateExhaustion }));

const { fixWork, humanFixDescription, reviewEscalate, reviewsHost, reviewWork } = await import('./review-effects');
const { pushRecoveryFollowupKey } = await import('@buildd/workflow-kernel/handlers/review');

const D = (o: any = {}) => ({
  id: 'd1', workspaceId: 'ws1', ownerTaskId: 'owner-1', repoFullName: 'acme/w', prNumber: 7, baseRef: 'dev', state: 'CHANGES_REQUESTED',
  stateReason: null, version: 4, currentHeadSha: 'H1', currentRound: 1, maxRounds: 3, boundAttemptId: null, resumeState: null,
  trunkIncidentId: null, approvedHeads: [], approvalBasis: null, compositionHeads: [], ci: null, ciHeadSha: null, mergeable: null,
  mergeableHeadSha: null, mergedAt: null, mergeCommitSha: null, supersededByPr: null, ...o,
});
const round1 = { id: 'r1', round: 1, headSha: 'H1', kind: 'full' as const, status: 'decided' as const, verdict: 'request_changes' as const, effectiveVerdict: 'request_changes' as const, failureCount: 0, reviewerTaskId: 'reviewer-1' };
const queuedRound = { ...round1, status: 'queued' as const, verdict: null, effectiveVerdict: null, reviewerTaskId: null };

const fixReq = (detail: Record<string, unknown> = {}) => ({
  role: 'fix', workspaceId: 'ws1', taskId: 'fix-1', dedupeKey: 'fix:a1',
  target: { repoFullName: 'acme/w', prNumber: 7, headSha: 'H1', baseRef: 'dev' },
  lineage: { deliveryId: 'd1', attemptId: 'a1', parentTaskId: 'owner-1' },
  detail: { roundId: 'r1', reviewerTaskId: 'reviewer-1', attemptNo: 1, maxAttempts: 3, firstAtHead: true, ...detail },
});
const reviewReq = (detail: Record<string, unknown> = {}, headSha = 'H2') => ({
  role: 'review', workspaceId: 'ws1', dedupeKey: 'review:r2',
  target: { repoFullName: 'acme/w', prNumber: 7, headSha, baseRef: 'dev' },
  lineage: { deliveryId: 'd1', parentTaskId: 'owner-1' },
  detail: { roundId: 'r2', round: 2, maxRounds: 3, ...detail },
});

beforeEach(() => {
  executeRows = [];
  ingested.length = 0; executed.length = 0; inserted.length = 0; notes.length = 0;
  existingTask = null; adoptedStatus = 'running'; missionRow = null; livePr = { state: 'open', merged: false, headSha: 'H1', headRepoFullName: 'acme/w', baseRef: 'dev' };
  roles = [{ slug: 'reviewer' }]; created = { id: 'reviewer-2' }; postResult = { posted: true };
  ghApi = (path) => { throw new Error(`no fake GitHub for ${path}`); }; workspaceReleaseConfig = null; ghCalls.length = 0;
  ownerRow = { id: 'owner-1', title: 'Fix the thing', description: 'd', missionId: 'm1', pathManifest: ['a.ts'], backend: 'claude', context: {} };
  for (const m of [mockPostPrReview, mockAppend, mockWake, mockCreateReviewer, mockSupersedeFix, mockEscalateExhaustion]) m.mockClear();
});

/** Every string/number a drizzle where-clause carries, however deeply nested. */
function literals(x: any, out: unknown[] = [], seen = new Set<any>()): unknown[] {
  if (x == null || seen.has(x)) return out;
  if (typeof x !== 'object') { out.push(x); return out; }
  seen.add(x);
  for (const v of Array.isArray(x) ? x : Object.values(x)) literals(v, out, seen);
  return out;
}

describe('fixWork (Work, role fix)', () => {
  test("looks the PR's worker up within the delivery's repo, not just workspace + number", async () => {
    workerQueries.length = 0;
    await fixWork(fixReq() as any);
    expect(workerQueries.length).toBeGreaterThan(0);
    expect(literals(capturedWhere(workerQueries[0].where)).some((v) => typeof v === 'string' && v.includes('acme/w'))).toBe(true);
  });

  test('the legacy-shaped fix row, linked to the delivery and attempt, with the reviewer\'s ask as its failure context', async () => {
    const b = await fixWork(fixReq() as any) as any;
    expect(b.values).toMatchObject({
      deliveryId: 'd1', deliveryRole: 'fix', parentTaskId: 'owner-1', taskClass: 'attempt',
      reviewerRetryPrNumber: 7, reviewerRetryHeadSha: 'H1', status: 'pending', creationSource: 'webhook',
    });
    expect(b.values.id).toBeUndefined();
    expect(b.values.context).toMatchObject({ workflowAttemptId: 'a1', workflowRoundId: 'r1', resumeBranch: 'feat/x', iteration: 1, maxIterations: 3, headSha: 'H1' });
    expect(b.values.context.failureContext.summary).toBe('check the caller task');
    await b.afterFile({ id: 'fix-1', title: 't' });
    expect(mockAppend.mock.calls[0][0]).toMatchObject({ entry: { kind: 'review_changes_requested', iteration: 1, maxIterations: 3, note: 'check the caller task' } });
  });

  test('a second attempt on the same head leaves the (PR, head) dedupe column empty; the ledger dedupes it', async () => {
    const b = await fixWork(fixReq({ firstAtHead: false }) as any) as any;
    expect(b.values.reviewerRetryHeadSha).toBeNull();
  });

  test("a person's apply puts their instructions first and the reviewer's words below", async () => {
    const b = await fixWork(fixReq({ trigger: 'human', humanInstructions: 'rename it', actor: 'human:u' }) as any) as any;
    expect(b.values.description).toBe(humanFixDescription('d', 'rename it', 'check the caller task'));
    expect(b.values).toMatchObject({ creationSource: 'dashboard', context: { trigger: 'human', appliedBy: 'human:u', humanInstructions: 'rename it' } });
  });

  test('a dependency bot\'s PR gets no fix, only a note on the PR', async () => {
    ownerRow = { ...ownerRow, context: { dependencyBot: true } };
    expect(await fixWork(fixReq() as any)).toEqual({ skipped: 'dependency_bot' });
    expect(mockAppend.mock.calls[0][0]).toMatchObject({ entry: { kind: 'review_escalated', detail: 'dependency-bot PR · no fix pushed' } });
  });
});

describe('reviewWork (Work, role review)', () => {
  test('the round\'s reviewer, bound to the round head, linked to delivery and round, carrying the prior verdict', async () => {
    const prior = { headSha: 'H1', verdict: 'request-changes', confidence: 0.9, summary: 's', feedback: 'check the caller task', escalationReason: null };
    const r = await reviewWork(reviewReq({ priorVerdict: prior, compositionScope: { novelDeltaPaths: ['b.ts'] } }) as any);
    expect(r).toEqual({ filed: { taskId: 'reviewer-2', created: true } });
    const p = mockCreateReviewer.mock.calls[0][0] as any;
    expect(p).toMatchObject({ headSha: 'H2', prNumber: 7, workflowRound: { deliveryId: 'd1', roundId: 'r2', round: 2 }, originalTask: { iteration: 1, maxIterations: 3 } });
    expect(p.priorVerdict).toMatchObject({ headSha: 'H1', verdict: 'request-changes', feedback: 'check the caller task' });
    expect(p.compositionScope).toEqual({ novelDeltaPaths: ['b.ts'] });
    expect(mockAppend.mock.calls[0][0]).toMatchObject({ entry: { kind: 'review_queued' } });
  });

  test('no role can run the review: no_role, which the kernel turns into a failed round (T27)', async () => {
    roles = [];
    expect(await reviewWork(reviewReq() as any)).toEqual({ skipped: 'no_role' });
    expect(mockCreateReviewer).not.toHaveBeenCalled();
  });

  test('a live reviewer another door filed for the head is adopted as the round\'s, not announced again', async () => {
    created = { id: 'reviewer-live', deduplicated: true };
    expect(await reviewWork(reviewReq() as any)).toEqual({ filed: { taskId: 'reviewer-live', created: false } });
    expect(mockAppend).not.toHaveBeenCalled();
  });

  test('an adopted reviewer nobody has claimed yet is answered unclaimed, so the kernel wakes it', async () => {
    created = { id: 'reviewer-orphan', deduplicated: true };
    adoptedStatus = 'pending';
    expect(await reviewWork(reviewReq() as any)).toEqual({ filed: { taskId: 'reviewer-orphan', created: false, unclaimed: true } });
    expect(mockAppend).not.toHaveBeenCalled();
  });
});

describe('reviewsHost.attestComposition (§5.9)', () => {
  const composed = (o: { headRef?: string; extraCommit?: boolean; liveHead?: string } = {}) => {
    workspaceReleaseConfig = { enabled: true, releaseBranch: 'dev', prodBranch: 'main' };
    const commits = [{ sha: 'SQ1', files: ['a.ts'], pr: 11 }, ...(o.extraCommit ? [{ sha: 'X1', files: ['b.ts'], pr: null }] : [])];
    const patch = (f: string) => ({ filename: f, status: 'modified', patch: `@@ -1 +1 @@\n-old\n+new ${f}` });
    ghApi = (path) => {
      if (path === '/repos/acme/w/pulls/7') return { head: { ref: o.headRef ?? 'dev', sha: o.liveHead ?? 'H1' }, base: { ref: 'main' } };
      // The constituent's reviewed head, diffed against the landed commit's parent.
      if (path === '/repos/acme/w/compare/B0...P11') return { files: [patch('a.ts')] };
      if (path.startsWith('/repos/acme/w/compare/main...H1')) return {
        merge_base_commit: { sha: 'B0' }, total_commits: commits.length,
        commits: commits.map((c) => ({ sha: c.sha, parents: [{ sha: 'B0' }], commit: { message: 'x' } })),
        files: commits.flatMap((c) => c.files).map((filename) => ({ filename })),
      };
      const c = commits.find((x) => path === `/repos/acme/w/commits/${x.sha}`);
      if (c) return { files: c.files.map(patch) };
      const pc = commits.find((x) => path === `/repos/acme/w/commits/${x.sha}/pulls`);
      if (pc) return pc.pr ? [{ number: pc.pr, merged_at: 't', base: { ref: 'dev' }, head: { sha: 'P11' } }] : [];
      throw new Error(`unexpected ${path}`);
    };
  };
  const withLedger = async (fn: () => Promise<void>) => {
    const db = (await import('@buildd/core/db')).db as any;
    const realExec = db.execute;
    db.execute = async (q: any) => {
      const text = JSON.stringify(q.queryChunks?.map((c: any) => c.value ?? '').flat());
      if (text.includes('composition_constituents')) return { rows: [{ id: 'd11', pr_number: 11, approved_heads: ['P11'], rounds: [{ id: 'r11', head_sha: 'P11', status: 'decided', effective_verdict: 'approve' }] }] };
      return realExec(q);
    };
    try { await fn(); } finally { db.execute = realExec; }
  };
  const attest = () => reviewsHost.attestComposition(D({ state: 'AWAITING_REVIEW' }) as any, queuedRound as any);

  test('a release PR whose changes were all reviewed is attested, so the round gets no second reviewer', async () => {
    composed();
    await withLedger(async () => { expect(await attest()).toBe('ok:composition_attested'); });
    expect(ingested[0]).toMatchObject({ kind: 'composition_attested', attestation: { prNumber: 7, aggregateHeadSha: 'H1', novelDelta: { result: 'none' } } });
    expect((ingested[0] as any).attestation.constituents[0]).toMatchObject({ mergedHeadSha: 'P11', landedSha: 'SQ1' });
  });

  test('the live head is read first: a PR that has moved past the round is not attested', async () => {
    composed({ liveHead: 'H2' });
    expect(await attest()).toBeNull();
    expect(ingested).toHaveLength(0);
    // The compare was never computed against the stale head.
    expect(ghCalls.some((p) => p.includes('/compare/'))).toBe(false);
  });

  test('an unverifiable composition (the constituent has no kernel review) falls through to the full review', async () => {
    composed();
    expect(await attest()).toBeNull();
    expect(ingested).toHaveLength(0);
  });

  describe('a mission branch refresh PR (trunk merged into the integration branch)', () => {
    const T = (m: Record<string, string>) => ({ truncated: false, tree: Object.entries(m).map(([path, sha]) => ({ path, mode: '100644', type: 'blob', sha })) });
    /** Trunk's reviewed squash SQ1 (PR #11) and the agent's merge M, whose only decision is the specs index. */
    const refreshPr = () => {
      missionRow = { workingBranch: 'mission/x', integrationBranchEnabled: true };
      const patch = (f: string) => ({ filename: f, status: 'modified', patch: `@@ -1 +1 @@\n-old\n+new ${f}` });
      ghApi = (path) => {
        if (path === '/repos/acme/w/pulls/7') return { head: { ref: 'buildd/abc-chore-mission-merge-dev', sha: 'H1' }, base: { ref: 'mission/x' } };
        if (path.startsWith('/repos/acme/w/compare/mission%2Fx...H1')) return {
          merge_base_commit: { sha: 'MS' }, base_commit: { sha: 'MS' }, total_commits: 2,
          commits: [{ sha: 'SQ1', parents: [{ sha: 'B0' }], commit: { message: 'feat: one' } }, { sha: 'H1', parents: [{ sha: 'MS' }, { sha: 'SQ1' }], commit: { message: 'Merge dev' } }],
          files: [{ filename: 'a.ts' }, { filename: 'docs/specs/INDEX.md' }],
        };
        if (path === '/repos/acme/w/commits/SQ1') return { files: [patch('a.ts')] };
        if (path === '/repos/acme/w/commits/H1') return { files: [patch('a.ts'), patch('docs/specs/INDEX.md')] };
        if (path === '/repos/acme/w/commits/SQ1/pulls') return [{ number: 11, merged_at: 't', base: { ref: 'dev' }, head: { sha: 'P11' } }];
        if (path === '/repos/acme/w/compare/B0...P11') return { files: [patch('a.ts')] };
        if (path === '/repos/acme/w/compare/SQ1...MS') return { status: 'diverged' };
        if (path === '/repos/acme/w/compare/SQ1...dev') return { status: 'ahead' };
        if (path === '/repos/acme/w/compare/MS...SQ1') return { merge_base_commit: { sha: 'B0' } };
        const c = /\/git\/commits\/(\w+)$/.exec(path);
        if (c) return { tree: { sha: `t-${c[1]}` } };
        const idx = 'docs/specs/INDEX.md';
        if (path === '/repos/acme/w/git/trees/t-B0?recursive=1') return T({ 'a.ts': 'b', [idx]: 'b' });
        if (path === '/repos/acme/w/git/trees/t-MS?recursive=1') return T({ 'a.ts': 'b', [idx]: 'm' });
        if (path === '/repos/acme/w/git/trees/t-SQ1?recursive=1') return T({ 'a.ts': 'd', [idx]: 'd' });
        if (path === '/repos/acme/w/git/trees/t-H1?recursive=1') return T({ 'a.ts': 'd', [idx]: 'md' });
        throw new Error(`unexpected ${path}`);
      };
    };
    const attestRefresh = () => reviewsHost.attestComposition(D({ state: 'AWAITING_REVIEW', baseRef: 'mission/x' }) as any, queuedRound as any);

    test('a resolution of generated files only is attested with no reviewer', async () => {
      refreshPr();
      ownerRow = { ...ownerRow, context: { requireMergeCommit: true, refreshTrunk: 'dev', refreshTrunkSha: 'SQ1' } };
      await withLedger(async () => { expect(await attestRefresh()).toBe('ok:composition_attested'); });
      expect(ingested[0]).toMatchObject({ kind: 'composition_attested', attestation: { novelDelta: { result: 'none' } } });
    });

    test('the same PR without the refresh context is an ordinary task PR: full review, no composition read', async () => {
      refreshPr();
      expect(await attestRefresh()).toBeNull();
      expect(ingested).toHaveLength(0);
      expect(ghCalls.some((p) => p.includes('/compare/'))).toBe(false);
    });
  });

  describe('a frozen release candidate (release/v1.2.3 → main, cut from dev)', () => {
    const meta = (o: Record<string, unknown> = {}) => `<!-- release-candidate ${JSON.stringify({
      schema: 1, version: '1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: 'SQ1', candidateSha: 'H1', baseRef: 'main', baseSha: 'B0', ...o,
    })} -->`;
    const candidatePr = (pull: Record<string, unknown> = {}) => {
      composed();
      workspaceReleaseConfig = {
        enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main',
        candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['github-actions[bot]'] },
      };
      const inner = ghApi;
      ghApi = (path) => path === '/repos/acme/w/pulls/7'
        ? {
          head: { ref: 'release/v1.2.3', sha: 'H1', repo: { full_name: 'acme/w' } }, base: { ref: 'main', repo: { full_name: 'acme/w' } },
          user: { login: 'github-actions[bot]' }, body: meta(), ...pull,
        }
        : inner(path);
    };

    test('a trusted candidate built from reviewed dev PRs is attested and gets no aggregate reviewer', async () => {
      candidatePr();
      await withLedger(async () => { expect(await attest()).toBe('ok:composition_attested'); });
      expect(ingested[0]).toMatchObject({ kind: 'composition_attested', attestation: { aggregateHeadSha: 'H1', novelDelta: { result: 'none' } } });
      // Constituents were looked up as PRs into dev, the candidate's source.
      expect(ghCalls).toContain('/repos/acme/w/commits/SQ1/pulls');
    });

    test('a spoofed candidate (not opened by the release workflow) gets the full review, no composition read', async () => {
      candidatePr({ user: { login: 'mallory' } });
      expect(await attest()).toBeNull();
      expect(ingested).toHaveLength(0);
      expect(ghCalls.some((p) => p.includes('/compare/'))).toBe(false);
    });

    test('a candidate whose head is not the recorded candidate SHA gets the full review', async () => {
      candidatePr({ body: meta({ candidateSha: 'OLD' }) });
      expect(await attest()).toBeNull();
      expect(ingested).toHaveLength(0);
    });
  });

  test('an ordinary PR is never checked for composition', async () => {
    composed({ headRef: 'buildd/abc-feature' });
    expect(await attest()).toBeNull();
    expect(ingested).toHaveLength(0);
  });
});

describe('reviewsHost records and reviewEscalate', () => {
  test('a review GitHub refused is recorded on the mission', async () => {
    await reviewsHost.postFailed(D() as any, { event: 'APPROVE', reason: 'bad token' });
    expect(notes[0]).toMatchObject({ type: 'warning', missionId: 'm1' });
    expect(notes[0].body).toContain('approve verdict, but posting it to GitHub as a review failed: bad token');
  });
  test('approve supersedes the open fix through the legacy supersession rules', async () => {
    await reviewsHost.supersedeFixOnApproval(D() as any);
    expect(mockSupersedeFix.mock.calls[0][0]).toMatchObject({ originalTaskId: 'owner-1', prNumber: 7, repoFullName: 'acme/w' });
  });
  test('review exhaustion escalates through the existing CAS-deduped helper, then the PR line', async () => {
    expect(await reviewEscalate.exhausted(D() as any, { family: 'review_fix', headSha: 'H1', attempts: 1, max: 3, title: 't', detail: 'after 1 review rounds', note: 'check the caller task' })).toBe('ok');
    expect(mockEscalateExhaustion).toHaveBeenCalledWith('owner-1', 'acme/w', 7, 'H1', 3, 'check the caller task');
    expect(mockAppend.mock.calls[0][0]).toMatchObject({ entry: { kind: 'review_escalated', detail: 'after 1 review rounds', note: 'check the caller task' } });
  });
  test("a round's output is its reviewer's structured output", async () => {
    expect(await reviewsHost.output(round1 as any)).toMatchObject({ verdict: 'request-changes', feedback: 'check the caller task' });
    expect(await reviewsHost.output({ ...round1, reviewerTaskId: null } as any)).toEqual({});
  });
});

describe('push_recovery keys (§9)', () => {
  test('9e27996d: follow-ups stay in their own chain: the head-keyed restart numbers its own tries', () => {
    expect(pushRecoveryFollowupKey('push_recovery:d1:L2:1', 1)).toBe('push_recovery:d1:L2:2');
    expect(pushRecoveryFollowupKey('push_recovery:d1:L2:2', 2)).toBe('push_recovery:d1:L2:3');
    expect(pushRecoveryFollowupKey('push_recovery:d1:none:1', 1)).toBe('push_recovery:d1:none:2');
    // The restart's first key carries no number; its follow-ups never land on the original chain's keys.
    expect(pushRecoveryFollowupKey('push_recovery:d1:L2:head:H2', 1)).toBe('push_recovery:d1:L2:head:H2:2');
    expect(pushRecoveryFollowupKey('push_recovery:d1:L2:head:H2:2', 2)).toBe('push_recovery:d1:L2:head:H2:3');
  });
});
