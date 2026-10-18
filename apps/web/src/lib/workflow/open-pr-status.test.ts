import { describe, expect, test } from 'bun:test';
import { classifyReleasePr } from '@buildd/core/release-candidate';
import type { KernelView } from '@buildd/workflow-kernel/types';
import { publishOpenPrStatuses, type LinkedRepo, type OpenPrStatusDeps } from './open-pr-status';

const H = (n: number) => `${n}`.repeat(40).slice(0, 40);
const REPO = 'acme/app';
const CONTEXTS = ['buildd/landing', 'Buildd / Review approval'];

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
}) {
  const statuses = new Map<string, { state: string; description: string }>(Object.entries(o.shown ?? {}));
  const writes: Array<{ sha: string; context: string; state: string; description: string }> = [];
  const enqueued: Array<{ deliveryId: string; version: number }> = [];
  const repos: LinkedRepo[] = [{ workspaceId: 'ws1', installationId: 1, repoFullName: REPO, releaseConfig: (o.releaseConfig ?? null) as LinkedRepo['releaseConfig'] }];
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
    reviews: async () => ({
      isCandidate: (config, pr) => classifyReleasePr(config, pr).kind === 'candidate',
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
      version, approvalBasis: 'review', approvedHeads: [sha], compositionHeads: [], currentRound: 1,
    },
    rounds: [{ id: 'r1', round: 1, headSha: sha, status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' }],
    attempts: [], findings: [],
  } as unknown as KernelView;
}

describe('every open PR head gets Buildd / Review approval (spec §4, AC-37)', () => {
  test('a PR no delivery owns (a dependency bot\'s, a draft): pending under both names, never success', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7), author: 'renovate[bot]' }, { number: 8, sha: H(8), draft: true }] });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes.map((w) => [w.sha.slice(0, 1), w.context, w.state])).toEqual([
      ['7', CONTEXTS[0], 'pending'], ['7', CONTEXTS[1], 'pending'], ['8', CONTEXTS[0], 'pending'], ['8', CONTEXTS[1], 'pending'],
    ]);
    expect(h.writes[1]!.description).toBe('Review not requested: no buildd review covers 7777777 yet');
    expect(s).toMatchObject({ checked: 2, published: 2, republished: 0, errors: 0, coverage: { verdict: 'covered', missing: [] } });
  });

  test('a second pass writes nothing (idempotent: GitHub already shows the answer)', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7) }] });
    await publishOpenPrStatuses(h.deps);
    const before = h.writes.length;
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes.length).toBe(before);
    expect(s).toMatchObject({ published: 0, unchanged: 1, coverage: { verdict: 'covered' } });
  });

  test('a review asked for: "Review in progress"', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7) }], review: 'in_progress' });
    await publishOpenPrStatuses(h.deps);
    expect(h.writes.at(-1)!.description.startsWith('Review in progress')).toBe(true);
  });

  test('a kernel-owned head missing its status: the kernel republishes it (an effect at its version), the host never writes it', async () => {
    const view = approvedView('d1', H(1));
    const h = harness({
      pulls: [{ number: 1, sha: H(1) }],
      owned: { 1: { id: 'd1', view } },
      onDrain: () => { for (const c of CONTEXTS) h.statuses.set(`${H(1)}|${c}`, { state: 'success', description: 'Ready to merge: 1111111 approved by review' }); },
    });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.enqueued).toEqual([{ deliveryId: 'd1', version: 5 }]);
    expect(h.writes).toEqual([]);
    expect(s).toMatchObject({ republished: 1, published: 0, coverage: { verdict: 'covered' } });
  });

  test('a kernel-owned head already showing the kernel\'s answer: nothing is enqueued', async () => {
    const view = approvedView('d1', H(1));
    const shown = Object.fromEntries(CONTEXTS.map((c) => [`${H(1)}|${c}`, { state: 'success', description: 'Ready to merge: 1111111 approved by review' }]));
    const h = harness({ pulls: [{ number: 1, sha: H(1) }], owned: { 1: { id: 'd1', view } }, shown });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.enqueued).toEqual([]);
    expect(s).toMatchObject({ unchanged: 1, coverage: { verdict: 'covered' } });
  });

  test('AC-38: a push the delivery has not seen never keeps the old head\'s success: the new head is pending', async () => {
    const view = approvedView('d1', H(1));
    const h = harness({ pulls: [{ number: 1, sha: H(2) }], owned: { 1: { id: 'd1', view } } });
    await publishOpenPrStatuses(h.deps);
    expect(h.enqueued).toEqual([]);
    expect(h.writes.map((w) => [w.sha, w.state])).toEqual([[H(2), 'pending'], [H(2), 'pending']]);
  });

  test('a frozen release candidate gets the release gate\'s answer at its SHA', async () => {
    const releaseConfig = { enabled: true, prodBranch: 'main', candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['release-bot[bot]'] } };
    const meta = { schema: 1, version: 'v1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: H(4), candidateSha: H(3), baseRef: 'main', baseSha: H(5), previousTag: null, amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: '2026-01-01T00:00:00Z' };
    const h = harness({
      releaseConfig,
      pulls: [{ number: 9, sha: H(3), headRef: 'release/v1.2.3', baseRef: 'main', author: 'release-bot[bot]', body: `<!-- release-candidate ${JSON.stringify(meta)} -->` }],
    });
    const s = await publishOpenPrStatuses(h.deps);
    expect(h.writes.at(-1)).toMatchObject({ sha: H(3), context: CONTEXTS[1], state: 'success', description: 'Ready to merge: release candidate 3333333 is verified' });
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
    const h = harness({ pulls: [{ number: 7, sha: H(7) }] });
    h.deps.owned = async () => (calls++ === 0 ? null : 'd1');
    h.deps.loadView = async () => view;
    await publishOpenPrStatuses(h.deps);
    expect(h.enqueued).toEqual([{ deliveryId: 'd1', version: 5 }]);
  });

  test('one repo failing to list does not stop the others, and counts as an error', async () => {
    const h = harness({ pulls: [{ number: 7, sha: H(7) }] });
    const repos = await h.deps.repos!();
    h.deps.repos = async () => [{ ...repos[0]!, repoFullName: 'acme/broken' }, ...repos];
    const list = h.deps.listOpenPulls!;
    h.deps.listOpenPulls = async (i, r) => { if (r === 'acme/broken') throw new Error('500'); return list(i, r); };
    const s = await publishOpenPrStatuses(h.deps);
    expect(s).toMatchObject({ errors: 1, checked: 1, published: 1 });
  });
});
