import { describe, expect, test } from 'bun:test';
import { classifyReleasePr } from '@buildd/core/release-candidate';
import type { KernelView } from '@buildd/workflow-kernel/types';
import { publishOpenPrStatuses, type LinkedRepo, type OpenPrStatusDeps } from './open-pr-status';

const H = (n: number) => `${n}`.repeat(40).slice(0, 40);
const REPO = 'acme/app';
const CONTEXT = 'Buildd / Review approval';

interface Pull { number: number; sha: string; headRef?: string; baseRef?: string; author?: string; body?: string; draft?: boolean }

function harness(o: {
  pulls: Pull[];
  owned?: Record<number, { id: string; view: KernelView }>;
  shown?: Record<string, { state: string; description: string }>;
  review?: 'not_requested' | 'in_progress';
  releaseConfig?: unknown;
  enqueueInserts?: boolean;
  /** What the kernel's republish writes when drained. */
  onDrain?: (deliveryId: string) => void;
  /** PR numbers buildd has no record of at all (`isForeignPr`); every other PR is known. */
  foreign?: number[];
  /** The primary workspace's gitConfig (`mergePolicy.autoReviewUnowned`). */
  gitConfig?: unknown;
}) {
  const statuses = new Map<string, { state: string; description: string }>(Object.entries(o.shown ?? {}));
  const writes: Array<{ sha: string; context: string; state: string; description: string }> = [];
  const enqueued: Array<{ deliveryId: string; version: number }> = [];
  const repos: LinkedRepo[] = [{ workspaceId: 'ws1', installationId: 1, repoFullName: REPO, releaseConfig: (o.releaseConfig ?? null) as LinkedRepo['releaseConfig'], gitConfig: o.gitConfig ?? null }];
  const deps: OpenPrStatusDeps = {
    repos: async () => repos,
    listOpenPulls: async () => o.pulls.map((p) => ({
      number: p.number, draft: p.draft ?? false, body: p.body ?? '', user: { login: p.author ?? 'dev' },
      head: { sha: p.sha, ref: p.headRef ?? `feat/${p.number}`, repo: { full_name: REPO } }, base: { ref: p.baseRef ?? 'dev', repo: { full_name: REPO } },
    })),
    statusOf: async (_i, _r, sha, context) => statuses.get(`${sha}|${context}`) ?? null,
    publish: async (_i, p) => {
      writes.push({ sha: p.sha, context: p.context, state: p.state, description: p.description });
      statuses.set(`${p.sha}|${p.context}`, { state: p.state, description: p.description });
    },
    owned: async (_ws, _r, n) => o.owned?.[n]?.id ?? null,
    loadView: async (id) => Object.values(o.owned ?? {}).find((x) => x.id === id)!.view,
    enqueueRepublish: async (deliveryId, version) => {
      enqueued.push({ deliveryId, version });
      return o.enqueueInserts ?? true;
    },
    drain: async (id) => { o.onDrain?.(id); },
    foreign: async (_links, _repo, pr) => (o.foreign ?? []).includes(pr.number),
    reviews: async () => ({
      isCandidate: (config, pr) => classifyReleasePr(config, pr).kind === 'candidate',
      mayBeCandidate: (config, refs) => config && config.enabled && config.candidate && config.candidate.branches?.some(pattern => {
        // Simple glob-like matching: 'release/v*' matches 'release/v1.2.3'
        const regex = new RegExp(`^${pattern.replace(/\*/g, '.*')}$`);
        return refs.headRef && regex.test(refs.headRef);
      }) || false,
      review: async () => o.review ?? 'not_requested',
      candidate: async () => ({ checks: [{ name: 'build', state: 'passing' }, { name: 'release candidate verified', state: 'passing' }], review: { verdict: 'pass' } }),
    }),
  };
  return { deps, writes, enqueued, statuses };
}

function approvedView(id: string, sha: string, version = 5): KernelView {
  return {
    delivery: {
      id, workspaceId: 'ws1', ownerTaskId: 't1', repoFullName: REPO, prNumber: 1, currentHeadSha: sha, baseRef: 'dev', state: 'APPROVED',
      version, approvalBasis: 'review', approvedHeads: [sha], compositionHeads: [], currentRound: 1, ci: 'green', ciHeadSha: sha,
    },
    rounds: [{ id: 'r1', round: 1, headSha: sha, status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' }],
    attempts: [], findings: [],
  } as unknown as KernelView;
}

describe('every open PR head gets Buildd / Review approval (spec §4, AC-76)', () => {
  test('a PR no delivery owns (a dependency bot\'s, a draft): pending, never success', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7), author: 'renovate[bot]' }, { number: 8, sha: H(8), draft: true }] });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes.map((w) => [w.sha.slice(0, 1), w.context, w.state])).toEqual([
      ['7', CONTEXT, 'pending'], ['8', CONTEXT, 'pending'],
    ]);
    expect(h.writes[0]!.description).toBe('Review not requested: no buildd review covers 7777777 yet');
    expect(s).toMatchObject({ checked: 2, published: 2, republished: 0, errors: 0, coverage: { verdict: 'covered', missing: [] } });
  });

  test('a second pass writes nothing (idempotent: GitHub already shows the answer)', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7), author: 'renovate[bot]' }] });
    await publishOpenPrStatuses(h.deps);
    const before = h.writes.length;
    expect(before).toBe(1);
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes.length).toBe(before);
    expect(s).toMatchObject({ published: 0, unchanged: 1, coverage: { verdict: 'covered' } });
  });

  test('a review asked for: "Review in progress"', async () => {
    // No delivery owns it, but a review was asked for: the PR is live, so the host writes (never skipped).
    const h = harness({ pulls: [{ number: 7, sha: H(7) }], review: 'in_progress' });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes.at(-1)!.description.startsWith('Review in progress')).toBe(true);
    expect(s).toMatchObject({ published: 1, skipped: 0 });
  });

  test('a kernel-owned head missing its status: the kernel republishes it (an effect at its version), the host never writes it', async () => {
    const view = approvedView('d1', H(1));
    const h = harness({
      pulls: [{ number: 1, sha: H(1) }],
      owned: { 1: { id: 'd1', view } },
      onDrain: () => { h.statuses.set(`${H(1)}|${CONTEXT}`, { state: 'success', description: 'Ready to merge: 1111111 approved by review' }); },
    });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.enqueued).toEqual([{ deliveryId: 'd1', version: 5 }]);
    expect(h.writes).toEqual([]);
    expect(s).toMatchObject({ republished: 1, published: 0, coverage: { verdict: 'covered' } });
  });

  test('a kernel-owned head already showing the kernel\'s answer: nothing is enqueued', async () => {
    const view = approvedView('d1', H(1));
    const shown = { [`${H(1)}|${CONTEXT}`]: { state: 'success', description: 'Ready to merge: 1111111 approved by review' } };
    const h = harness({ pulls: [{ number: 1, sha: H(1) }], owned: { 1: { id: 'd1', view } }, shown });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.enqueued).toEqual([]);
    expect(s).toMatchObject({ unchanged: 1, coverage: { verdict: 'covered' } });
  });

  test('AC-77: a push the delivery has not seen never keeps the old head\'s success: the new head is pending', async () => {
    const view = approvedView('d1', H(1));
    const h = harness({ pulls: [{ number: 1, sha: H(2) }], owned: { 1: { id: 'd1', view } } });
    await publishOpenPrStatuses(h.deps);
    expect(h.enqueued).toEqual([]);
    expect(h.writes.map((w) => [w.sha, w.state])).toEqual([[H(2), 'pending']]);
  });

  test('a frozen release candidate gets the release gate\'s answer at its SHA', async () => {
    const releaseConfig = { enabled: true, prodBranch: 'main', candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['release-bot[bot]'] } };
    const meta = { schema: 1, version: 'v1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: H(4), candidateSha: H(3), baseRef: 'main', baseSha: H(5), previousTag: null, amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: '2026-01-01T00:00:00Z' };
    const h = harness({
      releaseConfig,
      pulls: [{ number: 9, sha: H(3), headRef: 'release/v1.2.3', baseRef: 'main', author: 'release-bot[bot]', body: `<!-- release-candidate ${JSON.stringify(meta)} -->` }],
    });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes.at(-1)).toMatchObject({ sha: H(3), context: CONTEXT, state: 'success', description: 'Ready to merge: release candidate 3333333 is verified' });
    expect(s).toMatchObject({ candidates: 1 });
  });

  test('a release-shaped PR that is not a real candidate (another author) is an ordinary PR: pending', async () => {
    const releaseConfig = { enabled: true, prodBranch: 'main', candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['release-bot[bot]'] } };
    const h = harness({ releaseConfig, pulls: [{ number: 9, sha: H(3), headRef: 'release/v9.9.9', baseRef: 'main', author: 'someone' }] });
    await publishOpenPrStatuses(h.deps);
    expect(h.writes.at(-1)!.state).toBe('pending');
  });

  test('coverage can fail: a head still without the context is listed and counted', async () => {
    const view = approvedView('d1', H(1));
    // The republish effect is held already (same version) and the drain writes nothing.
    const h = harness({ pulls: [{ number: 1, sha: H(1) }], owned: { 1: { id: 'd1', view } }, enqueueInserts: false });
    const s = await publishOpenPrStatuses(h.deps);
    expect(s.coverage).toMatchObject({ verdict: 'gaps', missing: [{ repoFullName: REPO, prNumber: 1, sha: H(1) }] });
  });

  test('no open PR anywhere is nothing_checked, not covered', async () => {
    const h = harness({ pulls: [] });
    expect((await publishOpenPrStatuses(h.deps)).coverage.verdict).toBe('nothing_checked');
  });

  test('a PR claimed by the kernel while the host wrote pending: the kernel republishes after it', async () => {
    let calls = 0;
    const view = approvedView('d1', H(7));
    // A review was asked for, so the unowned PR is live and the host writes; the claim lands during that write.
    const h = harness({ pulls: [{ number: 7, sha: H(7) }], review: 'in_progress' });
    h.deps.owned = async () => (calls++ === 0 ? null : 'd1');
    h.deps.loadView = async () => view;
    await publishOpenPrStatuses(h.deps);
    expect(h.writes.length).toBe(1);
    expect(h.enqueued).toEqual([{ deliveryId: 'd1', version: 5 }]);
  });

  test('one repo failing to list does not stop the others, and counts as an error', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7), author: 'renovate[bot]' }] });
    const repos = await h.deps.repos!();
    h.deps.repos = async () => [{ ...repos[0]!, repoFullName: 'acme/broken' }, ...repos];
    const list = h.deps.listOpenPulls!;
    h.deps.listOpenPulls = async (i, r) => { if (r === 'acme/broken') throw new Error('500'); return list(i, r); };
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({ errors: 1, checked: 1, published: 1 });
  });

  test('a repo without statuses:write permission (403) skips all its PRs with a reason, not an error', async () => {
    // Use bot PRs so they don't get skipped as noDelivery; permission error happens during publish
    const h = harness({ pulls: [{ number: 7, sha: H(7), author: 'bot[bot]' }, { number: 8, sha: H(8), author: 'bot[bot]' }] });
    h.deps.publish = async (i, p) => {
      const error = new Error('GitHub API error: 403 Forbidden - Resource not accessible');
      throw error;
    };
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({
      checked: 2,
      published: 0,
      skipped: 2,
      skipReasons: { noStatusesPermission: 2, noDelivery: 0 },
      errors: 0,  // 403 permission denied is a skip, not an error
      coverage: { verdict: 'covered', missing: [] },  // skipped heads are marked as shown, so coverage is covered
    });
  });

  test('an ordinary PR with no delivery in a shared repo is skipped, not published', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7) }] });
    // owned returns null, meaning no delivery owns this PR
    h.deps.owned = async () => null;
    // Mock repos to return multiple workspaces for the same repo (shared repo)
    const repos = await h.deps.repos!();
    h.deps.repos = async () => [...repos, { ...repos[0], workspaceId: 'ws2' }];
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({
      checked: 1,
      published: 0,  // no writes for unowned ordinary PR in shared repo
      skipped: 1,     // counted as a skip
      skipReasons: { noDelivery: 1, noStatusesPermission: 0 },
      errors: 0,
      coverage: { verdict: 'covered' },  // skipped heads are marked as shown
    });
  });

  test('a closed delivery in a shared repo is skipped with noDelivery reason', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7) }] });
    // owned returns null, no delivery manages this PR (e.g., it's closed/stale)
    h.deps.owned = async () => null;
    const repos = await h.deps.repos!();
    h.deps.repos = async () => [...repos, { ...repos[0], workspaceId: 'ws2' }];
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({
      checked: 1,
      published: 0,
      skipped: 1,
      skipReasons: { noDelivery: 1, noStatusesPermission: 0 },
      errors: 0,
    });
  });

  test('repeat passes skip shared-repo PRs consistently (idempotent skips)', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7) }] });
    h.deps.owned = async () => null;
    const repos = await h.deps.repos!();
    h.deps.repos = async () => [...repos, { ...repos[0], workspaceId: 'ws2' }];
    const s1 = await publishOpenPrStatuses(h.deps);
    expect(s1).toMatchObject({ skipped: 1, published: 0 });
    const s2 = await publishOpenPrStatuses(h.deps);
    expect(s2).toMatchObject({ skipped: 1, published: 0 });
    expect(h.writes).toEqual([]);  // No writes on either pass
  });

  test('a rate-limit 403 is an error, not skipped (and subsequent PRs still run)', async () => {
    const h = harness({
      pulls: [{ number: 7, sha: H(7), author: 'bot[bot]' }, { number: 8, sha: H(8), author: 'bot[bot]' }],
    });
    let callCount = 0;
    h.deps.publish = async (i, p) => {
      callCount++;
      if (callCount === 1) {
        // First PR hits a rate-limit 403 (not a permission denied)
        const error = new Error('GitHub API error: 403 Rate limit exceeded');
        throw error;
      }
      // Second PR succeeds
      h.statuses.set(`${p.sha}|${p.context}`, { state: p.state, description: p.description });
    };
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({
      checked: 2,
      published: 1,  // second PR was still processed and published
      skipped: 0,
      errors: 1,  // rate-limit 403 is an error
      coverage: { verdict: 'gaps' },  // PR 7 has no status due to error
    });
  });

  test('a 403 from review reads does not skip the repo (is an error)', async () => {
    const h = harness({
      pulls: [{ number: 7, sha: H(7), author: 'bot[bot]' }, { number: 8, sha: H(8), author: 'bot[bot]' }],
    });
    let callCount = 0;
    h.deps.reviews = async () => {
      const base = await harness({}).deps.reviews!();
      return {
        ...base,
        review: async () => {
          callCount++;
          if (callCount === 1) {
            // First PR hits a 403 from review read (not statuses permission)
            const error = new Error('GitHub API error: 403 Reviews not accessible');
            throw error;
          }
          return 'not_requested';
        },
      };
    };
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({
      checked: 2,
      published: 1,  // second PR still runs and publishes
      skipped: 0,
      errors: 1,  // 403 from review is an error, not a permission skip
      coverage: { verdict: 'gaps' },  // PR 7 has no status due to error
    });
  });

  test('a 500 whose body contains "403" is an error, not skipped', async () => {
    const h = harness({
      pulls: [{ number: 7, sha: H(7), author: 'bot[bot]' }, { number: 8, sha: H(8), author: 'bot[bot]' }],
    });
    let callCount = 0;
    h.deps.publish = async (i, p) => {
      callCount++;
      if (callCount === 1) {
        // Simulate a 500 (not a 403, so not statuses permission)
        const error = new Error('GitHub API error: 500 Internal server error with 403 Forbidden caught in handler');
        throw error;
      }
      h.statuses.set(`${p.sha}|${p.context}`, { state: p.state, description: p.description });
    };
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({
      checked: 2,
      published: 1,  // second PR still runs and publishes
      skipped: 0,
      errors: 1,  // 500 is an error, not a permission skip
      coverage: { verdict: 'gaps' },  // PR 7 has no status due to error
    });
  });

  test('an ordinary publish failure is an error, not skipped (and subsequent PRs still run)', async () => {
    const h = harness({
      pulls: [{ number: 7, sha: H(7), author: 'bot[bot]' }, { number: 8, sha: H(8), author: 'bot[bot]' }],
    });
    let callCount = 0;
    h.deps.publish = async (i, p) => {
      callCount++;
      if (callCount === 1) {
        throw new Error('Network timeout');
      }
      h.statuses.set(`${p.sha}|${p.context}`, { state: p.state, description: p.description });
    };
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({
      checked: 2,
      published: 1,  // second PR still runs and publishes
      skipped: 0,
      errors: 1,
      coverage: { verdict: 'gaps' },  // PR 7 has no status due to error
    });
  });

  test('a release candidate PR in a shared repo is published, not skipped for noDelivery', async () => {
    const releaseConfig = { enabled: true, prodBranch: 'main', candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['release-bot[bot]'] } };
    const meta = { schema: 1, version: 'v1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: H(4), candidateSha: H(3), baseRef: 'main', baseSha: H(5), previousTag: null, amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: '2026-01-01T00:00:00Z' };
    const h = harness({
      releaseConfig,
      pulls: [{ number: 9, sha: H(3), headRef: 'release/v1.2.3', baseRef: 'main', author: 'release-bot[bot]', body: `<!-- release-candidate ${JSON.stringify(meta)} -->` }],
    });
    // No delivery owns this PR
    h.deps.owned = async () => null;
    // Make the repo shared (linked from 2 workspaces)
    const repos = await h.deps.repos!();
    h.deps.repos = async () => [...repos, { ...repos[0], workspaceId: 'ws2' }];
    const s = await publishOpenPrStatuses(h.deps);
    // Should be published as a candidate, not skipped
    expect(s).toMatchObject({
      checked: 1,
      published: 1,  // candidate status was published
      candidates: 1,
      skipped: 0,  // not skipped (even though no delivery owns it)
      skipReasons: { noDelivery: 0, noStatusesPermission: 0 },
      errors: 0,
      coverage: { verdict: 'covered' },
    });
  });
});

describe('a foreign PR (buildd has no record of it) and mergePolicy.autoReviewUnowned', () => {
  const ON = { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } } };
  const OFF = { mergePolicy: { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' }, autoReviewUnowned: false } };

  test('setting off: the floor writes no Buildd / Review approval on a foreign head, a draft or a bot PR included, and coverage does not count it missing', async () => {
    const h = harness({ gitConfig: OFF, foreign: [7, 8, 9], pulls: [{ number: 7, sha: H(7) }, { number: 8, sha: H(8), draft: true }, { number: 9, sha: H(9), author: 'renovate[bot]' }] });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes).toEqual([]);
    expect(s).toMatchObject({ checked: 3, published: 0, skipped: 3, skipReasons: { foreign: 3 }, errors: 0, coverage: { verdict: 'covered', missing: [] } });
  });

  test('setting off (the default for a tier other than agent-review): same', async () => {
    const h = harness({ gitConfig: { mergePolicy: { tier: 'human' } }, foreign: [8], pulls: [{ number: 8, sha: H(8), draft: true }] });
    await publishOpenPrStatuses(h.deps);
    expect(h.writes).toEqual([]);
  });

  test('setting off: a known PR with no review keeps its status exactly as today', async () => {
    const h = harness({ gitConfig: OFF, foreign: [], pulls: [{ number: 8, sha: H(8), draft: true }] });
    await publishOpenPrStatuses(h.deps);
    expect(h.writes.map((w) => [w.state, w.description])).toEqual([['pending', 'Review not requested: no buildd review covers 8888888 yet']]);
  });

  test('setting on: a foreign head auto-review did not take (draft, other base) gets no status either', async () => {
    const h = harness({ gitConfig: ON, foreign: [7, 8], pulls: [{ number: 7, sha: H(7), baseRef: 'some-feature' }, { number: 8, sha: H(8), draft: true }] });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes).toEqual([]);
    expect(s).toMatchObject({ skipped: 2, skipReasons: { foreign: 2 }, coverage: { verdict: 'covered' } });
  });

  test('setting on: a foreign head with its review requested reads "Review in progress"', async () => {
    const h = harness({ gitConfig: ON, foreign: [7], pulls: [{ number: 7, sha: H(7) }], review: 'in_progress' });
    await publishOpenPrStatuses(h.deps);
    expect(h.writes.at(-1)!.description.startsWith('Review in progress')).toBe(true);
  });

  test('a release candidate keeps its gate either way', async () => {
    const releaseConfig = { enabled: true, prodBranch: 'main', candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['release-bot[bot]'] } };
    const meta = { schema: 1, version: 'v1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: H(4), candidateSha: H(3), baseRef: 'main', baseSha: H(5), previousTag: null, amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: '2026-01-01T00:00:00Z' };
    for (const gitConfig of [ON, OFF]) {
      const h = harness({
        gitConfig, releaseConfig, foreign: [9],
        pulls: [{ number: 9, sha: H(3), headRef: 'release/v1.2.3', baseRef: 'main', author: 'release-bot[bot]', body: `<!-- release-candidate ${JSON.stringify(meta)} -->` }],
      });
      const s = await publishOpenPrStatuses(h.deps);
      expect(s).toMatchObject({ published: 1, candidates: 1, skipped: 0 });
    }
  });
});
