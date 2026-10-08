import { beforeEach, describe, expect, it, mock } from 'bun:test';
import {
  runLandingSweep,
  nextLookAt,
  markerCoversHead,
  dueMember,
  parseDueMember,
  PR_LANDING_DUE_QUEUE,
  LANDING_SWEEP_BATCH_CAP,
  LANDING_FLOOR_ENUMERATION_CAP,
  LANDING_RATE_LIMIT_MS,
  LANDING_REFRESH_BUDGET_MS,
  LANDING_CI_WAIT_MS,
  LANDING_FIX_PICKUP_MS,
  LANDING_RETRY_MS,
  LANDING_CYCLE_COOLDOWN_MS,
  type LandingSweepDeps,
  type LandingTarget,
  type PeekedPr,
  type PrRef,
} from './pr-landing-sweep';
import type { LandingOutcome, LandPrInput } from './pr-landing';
import type { LandingMarker } from './pr-landing-marker';

// ── Harness: stateful fakes, so two runs see what the first run changed ────────

const T0 = Date.parse('2030-01-01T01:00:00.000Z');
let clock: number;
let sleeps: number[];

interface FakePr extends PeekedPr {
  /** What `land` answers for this PR. */
  outcome: LandingOutcome | (() => LandingOutcome);
}
let prs: Map<number, FakePr>;
let markers: Map<number, LandingMarker>;
let skipFor: Map<number, string>;
let policyFor: (baseRef?: string | null) => any;
let policyBases: Array<string | null>;
let floorRefs: PrRef[];
let dueMembers: string[];
let dueStore: Map<string, number>;
let calls: { peek: number[]; land: LandPrInput[]; markDue: Array<[string, number]>; clearDue: string[][]; reseed: Array<Array<{ member: string; dueAtMs: number }>>; listFloor: number[]; listDue: number[] };

const target = (ref: PrRef): LandingTarget => ({
  workspaceId: ref.workspaceId,
  prNumber: ref.prNumber,
  installationId: 7,
  repoFullName: 'buildd-ai/buildd',
  policyFor: (baseRef) => policyFor(baseRef),
  owner: { taskId: `task-${ref.prNumber}`, workerId: `worker-${ref.prNumber}` },
  mission: null,
  releaseConfig: null,
});

const ref = (n: number, ws = 'ws-1'): PrRef => ({ workspaceId: ws, prNumber: n });
const open = (head = 'head1'): Omit<FakePr, 'outcome'> => ({ state: 'open', draft: false, headSha: head, baseRef: 'dev' });
const merged = (): LandingOutcome => ({ kind: 'merged', sha: 'sha' });

const makeDeps = (over: Partial<LandingSweepDeps> = {}): LandingSweepDeps => ({
  listFloor: async (limit) => {
    calls.listFloor.push(limit);
    return floorRefs.slice(0, limit);
  },
  listDue: async (nowMs, limit) => {
    calls.listDue.push(limit);
    return dueMembers.slice(0, limit);
  },
  resolveTarget: async (r) => {
    const skip = skipFor.get(r.prNumber);
    return skip ? { ok: false, skip: skip as any } : { ok: true, target: target(r) };
  },
  peek: async (t) => {
    calls.peek.push(t.prNumber);
    const pr = prs.get(t.prNumber);
    if (!pr) throw new Error('github down');
    return { state: pr.state, draft: pr.draft, headSha: pr.headSha, baseRef: pr.baseRef };
  },
  readMarker: async (t) => markers.get(t.prNumber) ?? null,
  land: async (input) => {
    calls.land.push(input);
    const pr = prs.get(input.prNumber)!;
    const out = typeof pr.outcome === 'function' ? pr.outcome() : pr.outcome;
    if (out.kind === 'merged') pr.state = 'merged';
    return out;
  },
  markDue: async (member, at) => {
    calls.markDue.push([member, at]);
    dueStore.set(member, at);
  },
  clearDue: async (members) => {
    calls.clearDue.push(members);
    for (const m of members) dueStore.delete(m);
  },
  reseedDue: async (entries) => {
    calls.reseed.push(entries);
    dueStore = new Map(entries.map((e) => [e.member, e.dueAtMs]));
  },
  sleep: async (ms) => {
    sleeps.push(ms);
    clock += ms;
  },
  now: () => clock,
  ...over,
});

const addPr = (n: number, outcome: FakePr['outcome'] = merged(), head = 'head1') => {
  prs.set(n, { ...open(head), outcome });
  floorRefs.push(ref(n));
};

beforeEach(() => {
  clock = T0;
  sleeps = [];
  prs = new Map();
  markers = new Map();
  skipFor = new Map();
  policyBases = [];
  policyFor = (baseRef = null) => {
    policyBases.push(baseRef);
    return { tier: 'agent-review' };
  };
  floorRefs = [];
  dueMembers = [];
  dueStore = new Map();
  calls = { peek: [], land: [], markDue: [], clearDue: [], reseed: [], listFloor: [], listDue: [] };
});

// ── Pure pieces ────────────────────────────────────────────────────────────────

describe('due member encoding', () => {
  it('round-trips workspace and PR number', () => {
    expect(parseDueMember(dueMember(ref(42, 'ws-9')))).toEqual(ref(42, 'ws-9'));
  });
  it.each(['', 'nocolon', 'ws:', ':5', 'ws:abc', 'ws:0', 'ws:-3', 'ws:1.5'])('rejects %p', (m) => {
    expect(parseDueMember(m)).toBeNull();
  });
  it('uses the queue name the route gates on', () => {
    expect(PR_LANDING_DUE_QUEUE).toBe('pr-landing');
  });
});

describe('nextLookAt', () => {
  // A spent refresh cycle is still the platform's to land: it comes back when
  // the cooldown lets landPr start a new cycle, instead of leaving the queue.
  it.each(['refresh_exhausted', 'refresh_unsafe'] as const)('%s comes back after the cycle cooldown', (cause) => {
    expect(nextLookAt({ kind: 'needs_human', cause, reason: 'x' }, T0)).toBe(T0 + LANDING_CYCLE_COOLDOWN_MS);
  });
  it('merged leaves the queue', () => {
    expect(nextLookAt(merged(), T0)).toBeNull();
  });
  it('updating_branch waits one refresh budget', () => {
    expect(nextLookAt({ kind: 'updating_branch', newHeadSha: 'h' }, T0)).toBe(T0 + LANDING_REFRESH_BUDGET_MS);
  });
  it('waiting_ci waits one CI interval', () => {
    expect(nextLookAt({ kind: 'waiting_ci', headSha: 'h' }, T0)).toBe(T0 + LANDING_CI_WAIT_MS);
  });
  it('needs_fix waits for the fix to be picked up', () => {
    expect(nextLookAt({ kind: 'needs_fix', fix: 'ci_fix', reason: 'x' }, T0)).toBe(T0 + LANDING_FIX_PICKUP_MS);
  });
  it('needs_human leaves the queue: a person owns it and the floor re-checks hourly', () => {
    expect(nextLookAt({ kind: 'needs_human', cause: 'size_cap', reason: 'x' }, T0)).toBeNull();
  });
  it.each(['landing_error', 'github_unreadable'] as const)('needs_human %s is transient: retry soon', (cause) => {
    expect(nextLookAt({ kind: 'needs_human', cause, reason: 'x' }, T0)).toBe(T0 + LANDING_RETRY_MS);
  });
});

describe('markerCoversHead', () => {
  const m = (over: Partial<LandingMarker> = {}): LandingMarker => ({
    prNumber: 1,
    pendingHeadSha: 'head1',
    baseShaAtUpdate: null,
    refreshCount: 1,
    firstApprovedGreenAt: null,
    lastOutcome: 'updating_branch',
    updatedAt: new Date(T0 - 60_000).toISOString(),
    ...over,
  });
  it('covers the live head inside the budget', () => {
    expect(markerCoversHead(m(), 'head1', T0)).toBe(true);
  });
  it('does not cover once the budget is spent', () => {
    const old = new Date(T0 - LANDING_REFRESH_BUDGET_MS - 1).toISOString();
    expect(markerCoversHead(m({ updatedAt: old }), 'head1', T0)).toBe(false);
  });
  it('does not cover a different head, another outcome, or a marker with no timestamp', () => {
    expect(markerCoversHead(m(), 'head2', T0)).toBe(false);
    expect(markerCoversHead(m({ lastOutcome: 'waiting_ci' }), 'head1', T0)).toBe(false);
    expect(markerCoversHead(m({ updatedAt: undefined }), 'head1', T0)).toBe(false);
    expect(markerCoversHead(m({ updatedAt: 'garbage' }), 'head1', T0)).toBe(false);
    expect(markerCoversHead(null, 'head1', T0)).toBe(false);
  });
});

// ── The one decision path ──────────────────────────────────────────────────────

describe('runLandingSweep — drives landPr, nothing else', () => {
  it('lands each candidate through the sweep door, in enforce mode, pinned to the head it just read', async () => {
    addPr(1, merged(), 'abc');
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(calls.land).toHaveLength(1);
    const input = calls.land[0];
    expect(input).toMatchObject({
      workspaceId: 'ws-1',
      installationId: 7,
      repoFullName: 'buildd-ai/buildd',
      prNumber: 1,
      eventHeadSha: 'abc',
      door: 'sweep',
      mode: 'enforce',
      actor: { kind: 'system' },
      owner: { taskId: 'task-1', workerId: 'worker-1' },
    });
    expect(res.merged).toBe(1);
    expect(res.processed).toBe(1);
  });

  it('passes the target\'s already-loaded gitConfig to landPr (no extra workspace read for surface ordering)', async () => {
    addPr(1, merged(), 'abc');
    const gitConfig = { surfaceOrdering: 'enforce' } as any;
    await runLandingSweep({ source: 'floor' }, makeDeps({ resolveTarget: async (r) => ({ ok: true, target: { ...target(r), gitConfig } }) }));
    expect(calls.land[0].gitConfig).toBe(gitConfig);
  });

  it('tallies every outcome kind', async () => {
    addPr(1, merged());
    addPr(2, { kind: 'updating_branch', newHeadSha: 'h' });
    addPr(3, { kind: 'waiting_ci', headSha: 'head1' });
    addPr(4, { kind: 'needs_fix', fix: 'ci_fix', reason: 'x' });
    addPr(5, { kind: 'needs_human', cause: 'size_cap', reason: 'x' });
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(res).toMatchObject({ enumerated: 5, processed: 5, merged: 1, updatingBranch: 1, waitingCi: 1, needsFix: 1, needsHuman: 1, errors: 0 });
  });

  it('counts a transient needs_human as an error so cron health alarms on it', async () => {
    addPr(1, { kind: 'needs_human', cause: 'landing_error', reason: 'x' });
    addPr(2, { kind: 'needs_human', cause: 'github_unreadable', reason: 'x' });
    addPr(3, { kind: 'needs_human', cause: 'branch_protection', reason: 'x' });
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(res.needsHuman).toBe(3);
    expect(res.errors).toBe(2);
  });
});

describe('runLandingSweep — who is skipped before landPr is ever called', () => {
  it.each(['no_open_worker', 'not_enforce', 'human_tier', 'not_approved', 'no_repo', 'no_installation'])(
    'skips a %s PR without a GitHub call and takes it off the queue',
    async (reason) => {
      addPr(1);
      skipFor.set(1, reason);
      dueStore.set(dueMember(ref(1)), T0);
      const res = await runLandingSweep({ source: 'floor' }, makeDeps());
      expect(calls.peek).toEqual([]);
      expect(calls.land).toEqual([]);
      expect(res.skipped[reason]).toBe(1);
      expect(dueStore.has(dueMember(ref(1)))).toBe(false);
    },
  );

  it.each([
    ['merged', { state: 'merged' }],
    ['closed', { state: 'closed' }],
    ['draft', { draft: true }],
  ])('skips a PR GitHub says is %s', async (reason, patch) => {
    addPr(1);
    Object.assign(prs.get(1)!, patch);
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(calls.peek).toEqual([1]);
    expect(calls.land).toEqual([]);
    expect(res.skipped[reason]).toBe(1);
  });
});

describe('runLandingSweep — policy follows the base GitHub reports', () => {
  it('resolves the policy against the freshly read base ref and hands it to landPr', async () => {
    addPr(1);
    prs.get(1)!.baseRef = 'mission/x';
    await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(policyBases).toEqual(['mission/x']);
    expect(calls.land[0].policy).toEqual({ tier: 'agent-review' });
  });

  it('skips a PR whose live base puts it on the human tier, without calling landPr', async () => {
    addPr(1);
    policyFor = () => ({ tier: 'human' });
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(calls.land).toEqual([]);
    expect(res.skipped.human_tier).toBe(1);
  });
});

// ── Bounds: batch, rate limit, time ────────────────────────────────────────────

describe('runLandingSweep — bounded', () => {
  it('processes at most one batch and defers the rest to the due queue', async () => {
    const total = LANDING_SWEEP_BATCH_CAP + 3;
    for (let i = 1; i <= total; i++) addPr(i);
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(calls.land).toHaveLength(LANDING_SWEEP_BATCH_CAP);
    expect(res.deferred).toBe(3);
    // Deferred refs are due now, so the next gated tick drains them.
    const deferred = [LANDING_SWEEP_BATCH_CAP + 1, LANDING_SWEEP_BATCH_CAP + 2, LANDING_SWEEP_BATCH_CAP + 3].map((n) => dueMember(ref(n)));
    for (const m of deferred) expect(dueStore.get(m)).toBeLessThanOrEqual(clock);
  });

  it('spaces GitHub calls: no sleep before the first, one between each', async () => {
    addPr(1);
    addPr(2);
    addPr(3);
    await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(sleeps).toEqual([LANDING_RATE_LIMIT_MS, LANDING_RATE_LIMIT_MS]);
  });

  it('does not sleep for a PR skipped before any GitHub call', async () => {
    addPr(1);
    addPr(2);
    skipFor.set(1, 'not_approved');
    await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(sleeps).toEqual([]);
  });

  it('stops at the time budget and leaves the rest due', async () => {
    addPr(1);
    addPr(2);
    addPr(3);
    const deps = makeDeps({
      sleep: async (ms) => {
        sleeps.push(ms);
        clock += 45_000;
      },
    });
    const res = await runLandingSweep({ source: 'floor', timeBudgetMs: 40_000 }, deps);
    expect(res.processed).toBeLessThan(3);
    expect(res.deferred).toBe(3 - res.processed);
    expect(dueStore.has(dueMember(ref(3)))).toBe(true);
  });

  it('enumerates the floor with a hard cap and reports truncation', async () => {
    for (let i = 1; i <= LANDING_FLOOR_ENUMERATION_CAP + 1; i++) floorRefs.push(ref(i));
    for (const r of floorRefs) prs.set(r.prNumber, { ...open(), outcome: { kind: 'needs_human', cause: 'size_cap', reason: 'x' } });
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(res.truncated).toBe(true);
    expect(res.enumerated).toBe(LANDING_FLOOR_ENUMERATION_CAP);
    expect(calls.listFloor).toEqual([LANDING_FLOOR_ENUMERATION_CAP + 1]);
  });
});

// ── Idempotency ────────────────────────────────────────────────────────────────

describe('runLandingSweep — idempotent', () => {
  it('two consecutive runs merge once: the second finds the PR already merged', async () => {
    addPr(1, merged());
    const deps = makeDeps();
    await runLandingSweep({ source: 'floor' }, deps);
    await runLandingSweep({ source: 'floor' }, deps);
    expect(calls.land).toHaveLength(1);
  });

  it('two consecutive runs over a PR waiting on a refresh dispatch one refresh', async () => {
    addPr(1, () => {
      markers.set(1, {
        prNumber: 1,
        pendingHeadSha: 'head1',
        baseShaAtUpdate: null,
        refreshCount: 1,
        firstApprovedGreenAt: null,
        lastOutcome: 'updating_branch',
        updatedAt: new Date(clock).toISOString(),
      });
      return { kind: 'updating_branch', newHeadSha: 'head1' };
    });
    const deps = makeDeps();
    await runLandingSweep({ source: 'floor' }, deps);
    clock += 60_000;
    const second = await runLandingSweep({ source: 'floor' }, deps);
    expect(calls.land).toHaveLength(1);
    expect(second.skipped.refresh_pending).toBe(1);
  });

  it('a PR already updating_branch within budget is left alone, and re-driven once the budget is spent', async () => {
    addPr(1, { kind: 'waiting_ci', headSha: 'head1' });
    markers.set(1, {
      prNumber: 1,
      pendingHeadSha: 'head1',
      baseShaAtUpdate: null,
      refreshCount: 1,
      firstApprovedGreenAt: null,
      lastOutcome: 'updating_branch',
      updatedAt: new Date(clock - 60_000).toISOString(),
    });
    const deps = makeDeps();
    const early = await runLandingSweep({ source: 'floor' }, deps);
    expect(calls.land).toEqual([]);
    expect(early.skipped.refresh_pending).toBe(1);
    // It stays on the queue, due exactly when the budget runs out.
    expect(dueStore.get(dueMember(ref(1)))).toBe(clock - 60_000 + LANDING_REFRESH_BUDGET_MS);

    clock += LANDING_REFRESH_BUDGET_MS;
    await runLandingSweep({ source: 'floor' }, deps);
    expect(calls.land).toHaveLength(1);
  });

  it('a ref enumerated twice in one run is landed once', async () => {
    addPr(1);
    floorRefs.push(ref(1));
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(calls.land).toHaveLength(1);
    expect(res.enumerated).toBe(1);
  });
});

// ── A head that moved between enumeration and action ───────────────────────────

describe('runLandingSweep — head moved under us', () => {
  it('passes the head it peeked as the event head, so landPr no-ops if the head has moved since', async () => {
    addPr(1, { kind: 'waiting_ci', headSha: 'head2' }, 'head1');
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(calls.land[0].eventHeadSha).toBe('head1');
    expect(res.headMoved).toBe(1);
    expect(res.waitingCi).toBe(1);
    expect(res.merged).toBe(0);
  });

  it('an updating_branch answer is not counted as a head move: a refresh the sweep started names a new head by design', async () => {
    addPr(1, { kind: 'updating_branch', newHeadSha: 'head2' }, 'head1');
    const res = await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(res.headMoved).toBe(0);
  });
});

// ── Source: due vs floor ───────────────────────────────────────────────────────

describe('runLandingSweep — due source', () => {
  it('enumerates from the due queue, not the DB floor query', async () => {
    addPr(1);
    floorRefs = [];
    dueMembers = [dueMember(ref(1))];
    const res = await runLandingSweep({ source: 'due' }, makeDeps());
    expect(calls.listFloor).toEqual([]);
    expect(calls.listDue).toEqual([LANDING_SWEEP_BATCH_CAP]);
    expect(calls.land).toHaveLength(1);
    expect(res.merged).toBe(1);
  });

  it('drops malformed members from the queue and carries on', async () => {
    addPr(1);
    floorRefs = [];
    dueMembers = ['garbage', dueMember(ref(1))];
    await runLandingSweep({ source: 'due' }, makeDeps());
    expect(calls.clearDue.flat()).toContain('garbage');
    expect(calls.land).toHaveLength(1);
  });

  it('applies each outcome to the queue as it goes: merged leaves, waiting reschedules', async () => {
    addPr(1, merged());
    addPr(2, { kind: 'waiting_ci', headSha: 'head1' });
    floorRefs = [];
    dueMembers = [dueMember(ref(1)), dueMember(ref(2))];
    dueStore.set(dueMember(ref(1)), T0);
    dueStore.set(dueMember(ref(2)), T0);
    await runLandingSweep({ source: 'due' }, makeDeps());
    expect(dueStore.has(dueMember(ref(1)))).toBe(false);
    expect(dueStore.get(dueMember(ref(2)))! - T0).toBeGreaterThanOrEqual(LANDING_CI_WAIT_MS);
    expect(calls.reseed).toEqual([]);
  });

  it('a failed GitHub read is an error and a retry, not a drop', async () => {
    addPr(1);
    prs.delete(1);
    floorRefs = [];
    dueMembers = [dueMember(ref(1))];
    const res = await runLandingSweep({ source: 'due' }, makeDeps());
    expect(res.errors).toBe(1);
    expect(calls.land).toEqual([]);
    expect(dueStore.get(dueMember(ref(1)))! - T0).toBeGreaterThanOrEqual(LANDING_RETRY_MS);
  });
});

describe('runLandingSweep — floor source re-seeds the queue', () => {
  it('replaces the whole set from what it found when the enumeration was complete', async () => {
    addPr(1, merged());
    addPr(2, { kind: 'waiting_ci', headSha: 'head1' });
    dueStore.set('stale:9', T0);
    await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(calls.reseed).toHaveLength(1);
    expect(calls.reseed[0].map((e) => e.member)).toEqual([dueMember(ref(2))]);
    expect(dueStore.has('stale:9')).toBe(false);
    expect(calls.markDue).toEqual([]);
  });

  it('seeds an empty set when nothing is left to watch (deletes the key)', async () => {
    dueStore.set('stale:9', T0);
    await runLandingSweep({ source: 'floor' }, makeDeps());
    expect(calls.reseed).toEqual([[]]);
  });

  it('upserts entry by entry, without replacing, when the enumeration was truncated', async () => {
    for (let i = 1; i <= LANDING_FLOOR_ENUMERATION_CAP + 1; i++) {
      floorRefs.push(ref(i));
      prs.set(i, { ...open(), outcome: { kind: 'waiting_ci', headSha: 'head1' } });
    }
    dueStore.set('other:1', T0);
    await runLandingSweep({ source: 'floor', batchCap: 5 }, makeDeps());
    expect(calls.reseed).toEqual([]);
    expect(dueStore.has('other:1')).toBe(true);
  });
});

// ── Isolation ──────────────────────────────────────────────────────────────────

describe('runLandingSweep — one bad PR does not stop the run', () => {
  it('counts a throwing land and carries on to the next PR', async () => {
    addPr(1);
    addPr(2);
    const deps = makeDeps({
      land: async (input) => {
        calls.land.push(input);
        if (input.prNumber === 1) throw new Error('boom');
        return merged();
      },
    });
    const res = await runLandingSweep({ source: 'floor' }, deps);
    expect(res.errors).toBe(1);
    expect(res.merged).toBe(1);
    expect(calls.land).toHaveLength(2);
  });

  it('counts a throwing target resolution', async () => {
    addPr(1);
    addPr(2);
    const deps = makeDeps({
      resolveTarget: async (r) => {
        if (r.prNumber === 1) throw new Error('db down');
        return { ok: true, target: target(r) };
      },
    });
    const res = await runLandingSweep({ source: 'floor' }, deps);
    expect(res.errors).toBe(1);
    expect(res.merged).toBe(1);
  });
});

describe('runLandingSweep — empty', () => {
  it('does nothing and says so', async () => {
    const res = await runLandingSweep({ source: 'due' }, makeDeps());
    expect(res).toMatchObject({ enumerated: 0, processed: 0, errors: 0, deferred: 0, truncated: false });
    expect(calls.peek).toEqual([]);
  });
});

// Every webhook for these PRs is lost: no green check suite, no review
// verdict, no conflict event. The only thing that moves them is the sweep,
// floor then due queue, on its own clock. Each converges with exactly one
// piece of work filed for it (landPr's own tests pin which decision each
// state gets; here the world answers the way landPr does).
describe('runLandingSweep — missed webhooks converge on the next sweeps', () => {
  /** Drain the due queue the way the gated tick does: whatever is due by `at`. */
  const dueTick = async (deps: LandingSweepDeps, at: number) => {
    clock = at;
    dueMembers = [...dueStore].filter(([, t]) => t <= at).map(([m]) => m);
    return runLandingSweep({ source: 'due' }, deps);
  };

  it('a never-reviewed green PR (#3654 shape) gets one review request, then lands once the verdict is in', async () => {
    let review: 'not_requested' | 'queued' | 'approved' = 'not_requested';
    let reviewRequests = 0;
    addPr(3654, () => {
      if (review === 'approved') return merged();
      if (review === 'queued') return { kind: 'waiting_ci', headSha: 'head1' };
      reviewRequests++;
      review = 'queued';
      return { kind: 'needs_fix', fix: 're_review', reason: 'no review was ever requested', taskId: 'review-1' };
    });
    const deps = makeDeps();

    await runLandingSweep({ source: 'floor' }, deps);
    expect(reviewRequests).toBe(1);
    expect(dueStore.get(dueMember(ref(3654)))).toBe(T0 + LANDING_FIX_PICKUP_MS);

    // The reviewer approves; its verdict webhook is lost too.
    review = 'approved';
    const res = await dueTick(deps, T0 + LANDING_FIX_PICKUP_MS);
    expect(res.merged).toBe(1);
    expect(reviewRequests).toBe(1);
    expect(dueStore.has(dueMember(ref(3654)))).toBe(false);
  });

  it('a conflicting PR (#3502 shape) gets one repair, and lands after the repair pushes', async () => {
    let repairs = 0;
    let resolved = false;
    addPr(3502, () => {
      if (resolved) return merged();
      repairs++;
      return { kind: 'needs_fix', fix: 'conflict', reason: 'PR has conflicts (mergeable_state: dirty)', taskId: 'repair-1' };
    });
    const deps = makeDeps();

    await runLandingSweep({ source: 'floor' }, deps);
    expect(repairs).toBe(1);

    // The repair pushed a merge commit; the synchronize webhook is lost.
    resolved = true;
    prs.get(3502)!.headSha = 'head2';
    const res = await dueTick(deps, T0 + LANDING_FIX_PICKUP_MS);
    expect(res.merged).toBe(1);
    expect(calls.land.at(-1)!.eventHeadSha).toBe('head2');
  });

  it('a lost due-queue entry costs one floor interval, not the PR', async () => {
    let review: 'not_requested' | 'approved' = 'not_requested';
    addPr(3654, () => {
      if (review === 'approved') return merged();
      review = 'approved';
      return { kind: 'needs_fix', fix: 're_review', reason: 'no review was ever requested', taskId: 'review-1' };
    });
    const deps = makeDeps();
    await runLandingSweep({ source: 'floor' }, deps);
    dueStore.clear();
    expect((await dueTick(deps, T0 + LANDING_FIX_PICKUP_MS)).processed).toBe(0);
    clock = T0 + 60 * 60_000;
    expect((await runLandingSweep({ source: 'floor' }, deps)).merged).toBe(1);
  });
});
