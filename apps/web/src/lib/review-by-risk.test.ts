/**
 * Review by risk — spec 62e985a8 "Review by risk", revision 2. Each AC-n has a
 * test named with its id. The rail is driven through the real
 * `evaluateAutoMergeSafety` with GitHub faked by path; the release half
 * through the pure summary rules and the seams the release doors expose.
 */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

// ── GitHub, faked by path ───────────────────────────────────────────────────
type Pr = { baseRef: string; headSha: string; mergeableState?: string; defaultBranch?: string };
let pr: Pr;
let prFiles: Array<{ filename: string; additions: number; deletions: number; status?: string; patch?: string }>;
const gh = mock(async (_inst: number, path: string): Promise<any> => {
  if (/\/commits\/[^/]+\/check-runs/.test(path)) {
    return { total_count: 2, check_runs: [
      { name: 'build', status: 'completed', conclusion: 'success', started_at: '2026-11-05T00:00:00Z' },
      { name: 'test', status: 'completed', conclusion: 'success', started_at: '2026-11-05T00:00:00Z' },
    ] };
  }
  if (/\/commits\/[^/]+\/status/.test(path)) return { total_count: 0, statuses: [] };
  if (/\/pulls\/\d+\/files/.test(path)) return prFiles;
  if (/\/pulls\/\d+$/.test(path)) {
    return {
      mergeable_state: pr.mergeableState ?? 'clean',
      head: { ref: 'buildd/feature', sha: pr.headSha, repo: { full_name: 'o/r' } },
      base: { ref: pr.baseRef, repo: { full_name: 'o/r', default_branch: pr.defaultBranch ?? 'main' } },
      user: { login: 'buildd-ai[bot]' },
      body: '',
    };
  }
  if (/\/compare\//.test(path)) return { behind_by: 0, files: prFiles };
  throw new Error(`unexpected GitHub read ${path}`);
});
const realGithub = await import('@/lib/github');
mock.module('@/lib/github', () => ({ ...realGithub, githubApi: (...a: [number, string]) => gh(...a), mergePullRequest: async () => ({ merged: true, message: 'merged' }) }));
mock.module('@/lib/migration-inspector', () => ({ inspectPullRequestMigrations: async () => ({ safe: true }) }));
mock.module('@buildd/core/db', () => ({ db: new Proxy({}, { get: () => { throw new Error('no db in this test'); } }) }));
const gateEvents: any[] = [];
const realLedger = await import('@/lib/gate-ledger');
mock.module('@/lib/gate-ledger', () => ({ ...realLedger, fireGateEvent: (e: unknown) => { gateEvents.push(e); } }));

const { evaluateAutoMergeSafety, classifyAutoMergeRefusal } = await import('@/lib/auto-merge');
const { resolvePolicy, DEFAULT_MERGE_POLICY } = await import('@/lib/merge-policy');
const rbr = await import('@/lib/review-by-risk');
const summary = await import('@/lib/release/summary');
const { parseMergePolicy } = await import('@buildd/shared');

const HEAD = 'a'.repeat(40);
const OLD_HEAD = 'b'.repeat(40);

const DEV_WORKFLOW = { targetBranch: 'dev', defaultBranch: 'dev' } as const;
const reviewByRisk = (areas: Record<string, string[]> = { dataMigrations: ['packages/core/drizzle/'], credentials: ['apps/web/src/lib/secrets/'], access: ['apps/web/src/lib/auth/'] }) =>
  ({ enabled: true, areas });
const gitConfigOn = (base: Record<string, unknown> = DEV_WORKFLOW, areas?: Record<string, string[]>) =>
  ({ ...base, mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'builder' }, reviewByRisk: reviewByRisk(areas) } }) as any;

const pinnedAllPass = async () => ({
  pinned: true as const,
  acIds: ['AC-1', 'AC-2'],
  standings: [
    { criterionId: 'AC-1', verdict: 'pass', source: 'test', headSha: HEAD },
    { criterionId: 'AC-2', verdict: 'pass', source: 'test', headSha: HEAD },
  ],
});

async function rail(gitConfig: any, extra: Record<string, unknown> = {}) {
  const policy = resolvePolicy({ gitConfig }, null, null, { baseRef: pr.baseRef });
  return evaluateAutoMergeSafety(1, 'o/r', 7, HEAD, policy, {
    gitConfig, workspaceId: null, taskId: 'task-1', skipBaseFreshness: true, ...extra,
  } as any);
}

beforeEach(() => {
  pr = { baseRef: 'dev', headSha: HEAD };
  prFiles = [{ filename: 'apps/web/src/lib/feature.ts', additions: 10, deletions: 2, status: 'modified', patch: '@@ -1 +1 @@\n-a\n+b' }];
  gateEvents.length = 0;
});

describe('review by risk — merging to the integration branch', () => {
  it('AC-1: a pinned PR, green, every AC tested at the head, no risk path → merges into the integration branch with no person, under the workspace merge method', async () => {
    // A large diff: R-1 has no size condition, so the auto-threshold cap is lifted for it.
    prFiles = [{ filename: 'apps/web/src/lib/feature.ts', additions: 3000, deletions: 0, status: 'modified', patch: '@@ -1 +1 @@\n+x' }];
    const gitConfig = { ...gitConfigOn(), mergeMethod: 'rebase' };
    const policy = resolvePolicy({ gitConfig }, null, null, { baseRef: 'dev' });
    expect(policy.tier).toBe('auto-threshold');
    expect(policy.reviewByRisk?.enabled).toBe(true);
    expect(await rail(gitConfig, { loadAcceptanceChecks: pinnedAllPass })).toEqual({ ok: true });
    // The rail decides nothing about the merge method: the workspace's own setting is left as stored.
    expect(gitConfig.mergeMethod).toBe('rebase');
    expect(gateEvents.filter((e) => e.gate === 'review_by_risk')).toHaveLength(0);
  });

  it('AC-2: a green PR adding a file under a listed Data migrations path waits for a person, naming the area and the path', async () => {
    prFiles.push({ filename: 'packages/core/drizzle/20261105000000_x/migration.sql', additions: 3, deletions: 0, status: 'added', patch: '@@ -0,0 +1 @@\n+ALTER TABLE t ADD c int;' });
    const r = await rail(gitConfigOn(), { loadAcceptanceChecks: pinnedAllPass });
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain('Data migrations');
    expect(reason).toContain('packages/core/drizzle/20261105000000_x/migration.sql');
    expect(reason).toContain('packages/core/drizzle/');
    expect(classifyAutoMergeRefusal(reason)).toBe('risk_area');
    expect(gateEvents.find((e) => e.gate === 'review_by_risk')?.outcome).toBe('deferred');
  });

  it('AC-2: a person merging it is the approval, recorded with who for the release summary', async () => {
    prFiles.push({ filename: 'packages/core/drizzle/20261105000000_x/migration.sql', additions: 3, deletions: 0, status: 'added', patch: '+x' });
    const r = await rail(gitConfigOn(), { personApproves: { approvedBy: 'user-1' } });
    expect(r).toEqual({ ok: true });
    const approval = gateEvents.find((e) => e.gate === 'review_by_risk' && e.outcome === 'bypassed');
    expect(approval?.detail?.approvedBy).toBe('user-1');
    expect(approval?.detail?.areas?.[0]?.area).toBe('dataMigrations');
  });

  it('AC-3: a PR that changes a test named with an AC id waits for a person, area Acceptance tests', async () => {
    prFiles = [{
      filename: 'apps/web/src/lib/thing.test.ts', additions: 1, deletions: 1, status: 'modified',
      patch: "@@ -10,3 +10,3 @@\n-  it('AC-3: holds the merge', async () => {\n+  it('AC-3: holds the merge, now looser', async () => {",
    }];
    const r = await rail(gitConfigOn(), { loadAcceptanceChecks: pinnedAllPass });
    expect(r.ok).toBe(false);
    expect((r as { reason: string }).reason).toContain('Acceptance tests');
    expect((r as { reason: string }).reason).toContain('AC-3');
    // A `check:` line counts too, in any file.
    expect(rbr.matchRiskAreas([{ filename: 'docs/spec.md', patch: '@@ -1 +1 @@\n+check: bun run test x' }], reviewByRisk()).map((h) => h.area)).toEqual(['acceptanceTests']);
    // An ordinary test change with no AC id is not an acceptance test.
    expect(rbr.matchRiskAreas([{ filename: 'a/b.test.ts', patch: "+  it('adds two numbers', () => {" }], reviewByRisk())).toEqual([]);
  });

  it('AC-4: a provisionally pinned PR meeting R-1 merges, is not held for the spec approval, and the summary lists it as built ahead', async () => {
    expect(await rail(gitConfigOn(), { loadAcceptanceChecks: pinnedAllPass })).toEqual({ ok: true });
    // R-8: the landing function's built-ahead hold treats the integration branch like a mission branch.
    expect(rbr.reviewByRiskFor({ gitConfig: gitConfigOn(), baseRef: 'dev' })).not.toBeNull();
    const { decideAheadHold } = await import('@/lib/specs/ahead-hold');
    const pin = { provisional: true, revision: 3 };
    const spec = { title: 'Some spec', approvedRevision: null, headRevision: 3 };
    expect(decideAheadHold({ pin, toMissionBranch: true, spec }).hold).toBe(false);
    expect(decideAheadHold({ pin, toMissionBranch: false, spec }).hold).toBe(true);

    const ends = summary.releaseEnds({ enabled: true, strategy: 'workflow_dispatch', workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main' }, DEV_WORKFLOW)!;
    const s = summary.buildReleaseSummary({
      headSha: HEAD,
      ends,
      items: [
        { prNumber: 11, title: 'plain', lede: 'A plain change.', areas: [], spec: null, builtAhead: false, migrations: [] },
        { prNumber: 12, title: 'ahead', lede: 'Work built ahead.', areas: [], spec: { specId: 's', title: 'Some spec', revision: 3, criteria: ['AC-1'] }, builtAhead: true, migrations: [] },
      ],
    });
    expect(s.items[0]!.prNumber).toBe(12);
    expect(summary.releaseSummaryLines(s)[1]).toContain('built ahead of approval');
  });

  it('AC-6: a pinned PR missing a passing test for one of its AC ids does not merge on its own and names the check', async () => {
    const load = async () => ({
      pinned: true as const,
      acIds: ['AC-1', 'AC-2'],
      standings: [
        { criterionId: 'AC-1', verdict: 'pass', source: 'test', headSha: HEAD },
        // A reviewer's pass is not a test, and a test pass on an older head does not count.
        { criterionId: 'AC-2', verdict: 'pass', source: 'review', headSha: HEAD },
      ],
    });
    const r = await rail(gitConfigOn(), { loadAcceptanceChecks: load });
    expect(r.ok).toBe(false);
    const reason = (r as { reason: string }).reason;
    expect(reason).toContain('AC-2');
    expect(reason).not.toContain('AC-1,');
    expect(classifyAutoMergeRefusal(reason)).toBe('ac_untested');
    expect(rbr.untestedAcceptanceChecks(['AC-1'], [{ criterionId: 'AC-1', verdict: 'pass', source: 'test', headSha: OLD_HEAD }], HEAD)).toEqual(['AC-1']);
    // R-3: an unpinned PR has no test condition.
    expect(await rail(gitConfigOn(), { loadAcceptanceChecks: async () => ({ pinned: false }) })).toEqual({ ok: true });
    // A pin whose checks cannot be read fails closed.
    const unreadable = await rail(gitConfigOn(), { loadAcceptanceChecks: async () => ({ pinned: true, error: 'gone' }) });
    expect(classifyAutoMergeRefusal((unreadable as { reason: string }).reason)).toBe('ac_untested');
  });
});

describe('review by risk — other setups', () => {
  it('AC-7: two workspaces each merge into their own integration branch and name their own release source and target; no branch name is hard-coded', async () => {
    const a = gitConfigOn({ targetBranch: 'dev', defaultBranch: 'dev' });
    const aRelease = { enabled: true, strategy: 'workflow_dispatch' as const, workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main' };
    const b = gitConfigOn({ targetBranch: 'develop', defaultBranch: 'develop' });
    const bRelease = { enabled: true, strategy: 'branch_merge' as const, prodBranch: 'release', releaseBranch: 'develop' };

    expect(rbr.workspaceIntegrationBranch(a)).toBe('dev');
    expect(rbr.workspaceIntegrationBranch(b)).toBe('develop');

    pr = { baseRef: 'dev', headSha: HEAD };
    expect(await rail(a, { loadAcceptanceChecks: pinnedAllPass })).toEqual({ ok: true });
    pr = { baseRef: 'develop', headSha: HEAD };
    expect(await rail(b, { loadAcceptanceChecks: pinnedAllPass })).toEqual({ ok: true });
    // A PR into `dev` in the `develop` workspace is not its integration branch: the mode does not govern it.
    expect(rbr.reviewByRiskFor({ gitConfig: b, baseRef: 'dev' })).toBeNull();
    expect(resolvePolicy({ gitConfig: b }, null, null, { baseRef: 'dev' }).tier).toBe('agent-review');

    const endsA = summary.releaseEnds(aRelease, a)!;
    const endsB = summary.releaseEnds(bRelease, b)!;
    expect([endsA.source, endsA.target, endsA.strategy]).toEqual(['dev', 'main', 'workflow_dispatch']);
    expect([endsB.source, endsB.target, endsB.strategy]).toEqual(['develop', 'release', 'branch_merge']);
    const lineA = summary.releaseSummaryLines(summary.buildReleaseSummary({ headSha: HEAD, ends: endsA, items: [] }))[0];
    const lineB = summary.releaseSummaryLines(summary.buildReleaseSummary({ headSha: HEAD, ends: endsB, items: [] }))[0];
    expect(lineA).toContain('dev into main');
    expect(lineB).toContain('develop into release');
    expect(summary.summaryApprovalRequired(a, aRelease)).toBe(true);
    expect(summary.summaryApprovalRequired(b, bRelease)).toBe(true);
  });

  it('AC-8: a workspace integrating straight into main with no release step: R-1 merges into main, an R-4 PR waits, no summary is made', async () => {
    const main = gitConfigOn({ defaultBranch: 'main' });
    pr = { baseRef: 'main', headSha: HEAD };
    expect(await rail(main, { loadAcceptanceChecks: pinnedAllPass })).toEqual({ ok: true });
    prFiles.push({ filename: 'apps/web/src/lib/auth/session.ts', additions: 1, deletions: 0, status: 'modified', patch: '+x' });
    const held = await rail(main, { loadAcceptanceChecks: pinnedAllPass });
    expect((held as { reason: string }).reason).toContain('Access');
    expect(summary.hasReleaseStep(null)).toBe(false);
    expect(summary.summaryApprovalRequired(main, null)).toBe(false);
    expect(summary.summaryApprovalRequired(main, { enabled: false })).toBe(false);
    expect(summary.releaseEnds(null, main)).toBeNull();
  });

  it('AC-9: a workspace without review by risk merges exactly as before', async () => {
    const off = { ...DEV_WORKFLOW, mergePolicy: { tier: 'auto-threshold', threshold: { maxLines: 800 } } } as any;
    const policy = resolvePolicy({ gitConfig: off }, null, null, { baseRef: 'dev' });
    expect(policy).toEqual({ tier: 'auto-threshold', threshold: { maxLines: 800 } });
    expect(resolvePolicy({ gitConfig: null }, null, null, { baseRef: 'dev' })).toBe(DEFAULT_MERGE_POLICY);
    // No hold, no acceptance-check read: a risk path and an untested pin merge as they always did.
    prFiles.push({ filename: 'packages/core/drizzle/x/migration.sql', additions: 1, deletions: 0, status: 'added', patch: '+x' });
    const neverRead = mock(async () => ({ pinned: true as const, acIds: ['AC-1'], standings: [] }));
    expect(await rail(off, { loadAcceptanceChecks: neverRead })).toEqual({ ok: true });
    expect(neverRead).not.toHaveBeenCalled();
    // The size cap still applies when the mode is off.
    prFiles = [{ filename: 'a.ts', additions: 3000, deletions: 0 }];
    expect((await rail(off)).ok).toBe(false);
    // A disabled setting reads as off.
    expect(rbr.reviewByRiskFor({ gitConfig: { ...DEV_WORKFLOW, mergePolicy: { tier: 'human', reviewByRisk: { enabled: false } } }, baseRef: 'dev' })).toBeNull();
  });

  it('AC-9: a host branch-protection rule that requires a review still holds a PR meeting R-1', async () => {
    pr = { baseRef: 'dev', headSha: HEAD, mergeableState: 'blocked' };
    const r = await rail(gitConfigOn(), { loadAcceptanceChecks: pinnedAllPass });
    expect(r.ok).toBe(false);
    expect(classifyAutoMergeRefusal((r as { reason: string }).reason)).toBe('blocked');
  });
});

describe('review by risk — release summary approval', () => {
  it('AC-5: with a release step and summary approval on, nothing ships until a person approves the summary for that commit', () => {
    const gc = gitConfigOn();
    for (const rc of [
      { enabled: true, strategy: 'workflow_dispatch' as const, workflowFile: 'release.yml', ref: 'dev', trigger: 'every_merge' as const },
      { enabled: true, strategy: 'branch_merge' as const, prodBranch: 'main', releaseBranch: 'dev', trigger: 'manual' as const },
      { enabled: true, strategy: 'script' as const, command: 'make ship', ref: 'dev', trigger: 'on_mission_complete' as const },
    ]) {
      const required = summary.summaryApprovalRequired(gc, rc);
      expect(required).toBe(true);
      expect(summary.decideReleaseApproval({ required, headSha: HEAD, approvedShas: [] }).blocks).toBe(true);
      // An approval of an older head does not cover a newer one.
      const stale = summary.decideReleaseApproval({ required, headSha: HEAD, approvedShas: [OLD_HEAD] });
      expect(stale.blocks).toBe(true);
      expect(summary.decideReleaseApproval({ required, headSha: HEAD, approvedShas: [OLD_HEAD, HEAD] }).blocks).toBe(false);
    }
    // The workspace can turn the approval off in its release config.
    expect(summary.summaryApprovalRequired(gc, { enabled: true, strategy: 'workflow_dispatch', workflowFile: 'r.yml', ref: 'dev', summaryApproval: false })).toBe(false);
  });

  it('AC-5: the dispatch door and the release-PR merge door ship nothing while the summary gate holds', async () => {
    const hold = async () => ({ blocks: true as const, reason: 'release waits for a person to approve its summary', clearedBy: 'approve it' });
    const { mergeReleasePrPinned } = await import('@/lib/release/pinned-merge');
    const merged = await mergeReleasePrPinned(
      { workspaceId: 'w', installationId: 1, repoFullName: 'o/r', prNumber: 9, verifiedHeadSha: HEAD, mergeMethod: 'merge', surface: 'test' } as any,
      { api: (async () => ({ merged: false, head: { sha: HEAD } })) as any, summaryGate: hold, owned: async () => false, reviewGate: async () => { throw new Error('must not reach the review gate'); } },
    );
    expect(merged.merged).toBe(false);
    expect((merged as { refused?: string }).refused).toBe('summary');

    const { recordAndDispatchRelease } = await import('@/lib/release/record');
    const dispatch = mock(async () => { throw new Error('must not dispatch'); });
    const out = await recordAndDispatchRelease(
      { workspaceId: 'w', archetype: 'gated', installationId: 1, owner: 'o', name: 'r', repoFullName: 'o/r', workflowFile: 'release.yml', ref: 'dev', prodBranch: 'main', inputs: {}, triggeredBy: 'auto' },
      { preflight: (async () => ({ refHeadSha: HEAD })) as any, dispatch: dispatch as any, summaryGate: hold, db: {} as any },
    );
    expect(out.ok).toBe(false);
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe('review by risk — the setting', () => {
  it('parses on the write path, off by default, with no paths needed for acceptance tests', () => {
    expect(parseMergePolicy({ tier: 'human', reviewByRisk: { enabled: true, areas: { access: ['apps/auth/'] } } }).ok).toBe(true);
    expect(parseMergePolicy({ tier: 'human', reviewByRisk: { enabled: true, areas: { acceptanceTests: ['x'] } } }).ok).toBe(false);
    expect(parseMergePolicy({ tier: 'human', reviewByRisk: { enabled: 'yes' } }).ok).toBe(false);
    expect(parseMergePolicy({ tier: 'human', reviewByRisk: { enabled: true, areas: { access: ['../etc'] } } }).ok).toBe(false);
    expect(rbr.emptyRiskAreas({ enabled: true, areas: { access: ['a/'] } })).toEqual(['credentials', 'dataMigrations']);
  });

  it('only a person changes it; a save without the key keeps the stored one', () => {
    const stored = { tier: 'agent-review', reviewByRisk: { enabled: true } };
    expect(rbr.applyReviewByRiskWrite({ previous: stored, next: { tier: 'human' }, byPerson: false })).toEqual({ ok: true, next: { tier: 'human', reviewByRisk: { enabled: true } } });
    expect(rbr.applyReviewByRiskWrite({ previous: stored, next: { tier: 'human', reviewByRisk: { enabled: false } }, byPerson: false }).ok).toBe(false);
    expect(rbr.applyReviewByRiskWrite({ previous: { tier: 'human' }, next: { tier: 'human', reviewByRisk: { enabled: true } }, byPerson: false }).ok).toBe(false);
    expect(rbr.applyReviewByRiskWrite({ previous: stored, next: null, byPerson: false }).ok).toBe(false);
    expect(rbr.applyReviewByRiskWrite({ previous: stored, next: { tier: 'human', reviewByRisk: { enabled: false } }, byPerson: true }).ok).toBe(true);
    expect(rbr.applyReviewByRiskWrite({ previous: undefined, next: { tier: 'human' }, byPerson: false })).toEqual({ ok: true, next: { tier: 'human' } });
  });

  it('a mission policy never turns it on, and a mission integration branch keeps its own rules', () => {
    const mission = { mergePolicy: { tier: 'auto-threshold', reviewByRisk: { enabled: true } } as any, workingBranch: 'mission/x-12345678', integrationBranchEnabled: true };
    expect(resolvePolicy({ gitConfig: DEV_WORKFLOW as any }, mission, null, { baseRef: 'dev' }).reviewByRisk).toBeUndefined();
    expect(rbr.reviewByRiskFor({ gitConfig: gitConfigOn({ targetBranch: 'mission/x-12345678' }), baseRef: 'mission/x-12345678', mission })).toBeNull();
  });
});
