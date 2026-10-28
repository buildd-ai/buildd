import { describe, expect, test } from 'bun:test';
import { classifyReleasePr } from '@buildd/core/release-candidate';
import type { KernelView } from '@buildd/workflow-kernel/types';
import { publishOpenPrHead, type LinkedRepo, type OpenPrStatusDeps } from './open-pr-status';
import { republishPrHeads } from './open-pr-events';
import { mayBeCandidate } from '../release/open-pr-review';

const H = (n: number) => `${n}`.repeat(40).slice(0, 40);
const REPO = 'acme/app';
const CONTEXT = 'Buildd / Review approval';
const releaseConfig = { enabled: true, prodBranch: 'main', candidate: { branches: ['release/v*'], sourceBranch: 'dev', authors: ['release-bot[bot]'] } };
const meta = { schema: 1, version: 'v1.2.3', branch: 'release/v1.2.3', sourceRef: 'dev', sourceSha: H(4), candidateSha: H(3), baseRef: 'main', baseSha: H(5), previousTag: null, amendment: 0, previousCandidateSha: null, supersedes: null, cutAt: '2026-01-01T00:00:00Z' };

type Check = { name: string; state: 'passing' | 'pending' | 'failing' | 'missing' };
const passing: Check[] = [{ name: 'build', state: 'passing' }, { name: 'release candidate verified', state: 'passing' }];

function harness(o: { sha: string; state?: string; candidate?: boolean; candidateConfig?: boolean; checks?: () => Check[]; verdict?: () => 'pass' | 'pending' | 'changes_requested'; linked?: boolean; foreign?: boolean; gitConfig?: unknown }) {
  let pulls = 0;
  const statuses = new Map<string, { state: string; description: string }>();
  const writes: Array<{ sha: string; context: string; state: string }> = [];
  const live = { sha: o.sha, state: o.state ?? 'open' };
  const deps: OpenPrStatusDeps & { getPull: NonNullable<Parameters<typeof publishOpenPrHead>[1]>['getPull'] } = {
    repos: async () => (o.linked === false ? [] : [{ workspaceId: 'ws1', installationId: 1, repoFullName: REPO, releaseConfig: (o.candidate || o.candidateConfig ? releaseConfig : null) as LinkedRepo['releaseConfig'], gitConfig: o.gitConfig ?? null }]),
    getPull: async () => (pulls++, {
      number: 9, state: live.state, body: o.candidate ? `<!-- release-candidate ${JSON.stringify(meta)} -->` : '', user: { login: o.candidate ? 'release-bot[bot]' : 'dev' },
      head: { sha: live.sha, ref: o.candidate ? 'release/v1.2.3' : 'feat/x', repo: { full_name: REPO } }, base: { ref: o.candidate ? 'main' : 'dev', repo: { full_name: REPO } },
    }),
    statusOf: async (_i, _r, sha, context) => statuses.get(`${sha}|${context}`) ?? null,
    publish: async (_i, p) => { writes.push({ sha: p.sha, context: p.context, state: p.state }); statuses.set(`${p.sha}|${p.context}`, { state: p.state, description: p.description }); },
    owned: async () => null,
    foreign: async () => o.foreign ?? false,
    reviews: async () => ({
      isCandidate: (config, pr) => classifyReleasePr(config, pr).kind === 'candidate',
      mayBeCandidate,
      review: async () => 'not_requested',
      candidate: async () => ({ checks: (o.checks ?? (() => passing))(), review: { verdict: (o.verdict ?? (() => 'pass'))() } as never }),
    }),
  };
  return { deps, writes, statuses, live, pulls: () => pulls };
}
const at = (n: number) => ({ installationId: 1, repoFullName: REPO, prNumber: 9, sha: H(n) });
const stateOn = (h: ReturnType<typeof harness>, sha: string) => h.statuses.get(`${sha}|${CONTEXT}`)?.state;

describe('an event publishes one open head now (AC-78)', () => {
  test('a foreign PR (buildd has no record of it) with autoReviewUnowned off: the webhook path writes no status at all', async () => {
    const h = harness({ sha: H(1), foreign: true, gitConfig: { mergePolicy: { tier: 'human' } } });
    expect(await publishOpenPrHead(at(1), h.deps)).toBe('skipped_foreign');
    expect(h.writes).toEqual([]);
  });

  test('a foreign PR with autoReviewUnowned on: written as today (the auto-review runs before it)', async () => {
    const h = harness({ sha: H(1), foreign: true, gitConfig: { mergePolicy: { tier: 'human', autoReviewUnowned: true } } });
    expect(await publishOpenPrHead(at(1), h.deps)).toBe('published');
  });

  test('a known PR with autoReviewUnowned off: written as today', async () => {
    const h = harness({ sha: H(1), foreign: false, gitConfig: { mergePolicy: { tier: 'human' } } });
    expect(await publishOpenPrHead(at(1), h.deps)).toBe('published');
    expect(stateOn(h, H(1))).toBe('pending');
  });

  test('a release candidate with autoReviewUnowned off still gets its gate', async () => {
    const h = harness({ sha: H(3), candidate: true, foreign: true, gitConfig: { mergePolicy: { tier: 'human' } } });
    expect(await publishOpenPrHead(at(3), h.deps)).toBe('published');
  });


  test('a newly opened PR gets pending at once, under the one name (never the retired buildd/landing)', async () => {
    const h = harness({ sha: H(1) });
    expect(await publishOpenPrHead(at(1), h.deps)).toBe('published');
    expect(h.writes.map((w) => w.context)).toEqual([CONTEXT]);
    expect(stateOn(h, H(1))).toBe('pending');
  });

  test('a duplicate event writes nothing', async () => {
    const h = harness({ sha: H(1) });
    await publishOpenPrHead(at(1), h.deps);
    const n = h.writes.length;
    expect(await publishOpenPrHead(at(1), h.deps)).toBe('unchanged');
    expect(h.writes.length).toBe(n);
  });

  test('an older head\'s event (the PR has moved on) writes nothing', async () => {
    const h = harness({ sha: H(2) });
    expect(await publishOpenPrHead(at(1), h.deps)).toBe('skipped_stale_head');
    expect(h.writes).toEqual([]);
  });

  test('a PR that is closed, or in a repo no workspace links, is skipped', async () => {
    expect(await publishOpenPrHead(at(1), harness({ sha: H(1), state: 'closed' }).deps)).toBe('skipped_not_open');
    expect(await publishOpenPrHead(at(1), harness({ sha: H(1), linked: false }).deps)).toBe('skipped_unlinked');
  });

  test('a candidate goes success, then a failing re-run on the same SHA flips it to failure at once; a replayed older event cannot bring success back', async () => {
    let checks: Check[] = passing;
    const h = harness({ sha: H(3), candidate: true, checks: () => checks });
    await publishOpenPrHead(at(3), h.deps);
    expect(stateOn(h, H(3))).toBe('success');
    checks = [{ name: 'build', state: 'failing' }, passing[1]!];
    await publishOpenPrHead(at(3), h.deps);
    expect(stateOn(h, H(3))).toBe('failure');
    // The earlier "completed" event arrives again: it derives from what is true now.
    await publishOpenPrHead(at(3), h.deps);
    expect(stateOn(h, H(3))).toBe('failure');
  });

  test('a later review verdict against a verified candidate flips it, and a re-run starting makes it pending', async () => {
    let verdict: 'pass' | 'changes_requested' = 'pass';
    let checks: Check[] = passing;
    const h = harness({ sha: H(3), candidate: true, checks: () => checks, verdict: () => verdict });
    await publishOpenPrHead(at(3), h.deps);
    verdict = 'changes_requested';
    await publishOpenPrHead(at(3), h.deps);
    expect(stateOn(h, H(3))).toBe('failure');
    verdict = 'pass';
    checks = [{ name: 'build', state: 'pending' }, passing[1]!];
    await publishOpenPrHead(at(3), h.deps);
    expect(stateOn(h, H(3))).toBe('pending');
  });

  test('inputs that move while it writes are followed: the write that finishes last is the newest answer', async () => {
    let reads = 0;
    // The first derivation sees success; by the time it has written, the check has failed.
    const h = harness({ sha: H(3), candidate: true, checks: () => (reads++ === 0 ? passing : [{ name: 'build', state: 'failing' }, passing[1]!]) });
    await publishOpenPrHead(at(3), h.deps);
    expect(stateOn(h, H(3))).toBe('failure');
  });

  test('never enqueues or drains a kernel effect on the web host', async () => {
    // A head a delivery owns, missing the kernel's answer: the floor would enqueue and drain its republish.
    const h = harness({ sha: H(1) });
    h.deps.owned = async () => 'd1';
    h.deps.loadView = async () => ownedView(H(1));
    let touched = false;
    h.deps.enqueueRepublish = async () => { touched = true; return true; };
    h.deps.drain = async () => { touched = true; };
    await publishOpenPrHead(at(1), h.deps);
    expect(touched).toBe(false);
    expect(h.writes).toEqual([]);
  });
});

function ownedView(sha: string): KernelView {
  return {
    delivery: {
      id: 'd1', workspaceId: 'ws1', ownerTaskId: 't1', repoFullName: REPO, prNumber: 9, currentHeadSha: sha, baseRef: 'dev', state: 'APPROVED',
      version: 5, approvalBasis: 'review', approvedHeads: [sha], compositionHeads: [], currentRound: 1,
    },
    rounds: [{ id: 'r1', round: 1, headSha: sha, status: 'decided', verdict: 'approve', effectiveVerdict: 'approve' }],
    attempts: [], findings: [],
  } as unknown as KernelView;
}

describe('a review asked for on a verified candidate (R-41, AC-78)', () => {
  test('its success turns pending at once', async () => {
    let verdict: 'pass' | 'pending' = 'pass';
    const h = harness({ sha: H(3), candidate: true, verdict: () => verdict });
    await publishOpenPrHead(at(3), h.deps);
    expect(stateOn(h, H(3))).toBe('success');
    // The reviewer task is stored: the review gate reads a running review as pending.
    verdict = 'pending';
    await republishPrHeads(1, REPO, [{ number: 9, sha: H(3) }], { candidatesOnly: true, publish: (p) => publishOpenPrHead(p, h.deps) });
    expect(stateOn(h, H(3))).toBe('pending');
  });
});

describe('check and review-request events only read release candidates', () => {
  test('a repo whose workspaces declare no candidates is skipped before any GitHub read', async () => {
    const h = harness({ sha: H(1) });
    expect(await publishOpenPrHead({ ...at(1), candidatesOnly: true }, h.deps)).toBe('skipped_not_candidate');
    expect(h.pulls()).toBe(0);
    expect(h.writes).toEqual([]);
  });

  test('a PR whose branches are not candidate-shaped is skipped unread', async () => {
    const h = harness({ sha: H(1), candidateConfig: true });
    expect(await publishOpenPrHead({ ...at(1), candidatesOnly: true, headRef: 'feat/x', baseRef: 'dev' }, h.deps)).toBe('skipped_not_candidate');
    expect(h.pulls()).toBe(0);
  });

  test('a PR read and found not to be a candidate writes nothing', async () => {
    const h = harness({ sha: H(1), candidateConfig: true });
    expect(await publishOpenPrHead({ ...at(1), candidatesOnly: true }, h.deps)).toBe('skipped_not_candidate');
    expect(h.writes).toEqual([]);
  });

  test('a candidate is published', async () => {
    const h = harness({ sha: H(3), candidate: true });
    expect(await publishOpenPrHead({ ...at(3), candidatesOnly: true, headRef: 'release/v1.2.3', baseRef: 'main' }, h.deps)).toBe('published');
    expect(stateOn(h, H(3))).toBe('success');
  });

  test('mayBeCandidate reads the branches against the release config', () => {
    expect(mayBeCandidate(null, {})).toBe(false);
    expect(mayBeCandidate(releaseConfig as never, {})).toBe(true);
    expect(mayBeCandidate(releaseConfig as never, { headRef: 'release/v1.2.3', baseRef: 'main' })).toBe(true);
    expect(mayBeCandidate(releaseConfig as never, { headRef: 'release/v1.2.3', baseRef: 'dev' })).toBe(false);
    expect(mayBeCandidate(releaseConfig as never, { headRef: 'feat/x', baseRef: 'main' })).toBe(false);
  });
});
