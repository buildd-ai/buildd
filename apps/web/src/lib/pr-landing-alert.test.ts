import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  alertOnLanding,
  actionsForReason,
  overrideForAction,
  FIX_PICKUP_BOUND_MS,
  INVARIANT_ALARM_MS,
  type LandingAlertDeps,
  type LandingAlertInput,
} from './pr-landing-alert';
import { verifyLandingActionToken } from './landing-action-token';
import type { LandingOutcome } from './pr-landing';

const MIN = 60_000;

/** In-memory stand-ins for the task-context CAS writes, so concurrency is exercised for real. */
function makeDeps(start = 1_000_000_000_000) {
  const state = {
    now: start,
    observed: new Map<string, string>(),
    progress: new Map<string, { fp: string; since: string }>(),
    paged: new Set<string>(),
    sent: [] as Array<{ subject: any; payload: any }>,
  };
  const deps: LandingAlertDeps = {
    now: () => state.now,
    async observe(taskId, key, nowIso, startIfAbsent) {
      const k = `${taskId}|${key}`;
      if (!state.observed.has(k) && startIfAbsent) state.observed.set(k, nowIso);
      return state.observed.get(k) ?? null;
    },
    async markProgress(taskId, fp, nowIso) {
      const cur = state.progress.get(taskId);
      if (cur?.fp === fp) return cur.since;
      state.progress.set(taskId, { fp, since: nowIso });
      return nowIso;
    },
    async hasPagedHead(taskId, prefix) {
      return [...state.paged].some((k) => k.startsWith(`${taskId}|${prefix}`));
    },
    async claimKey(taskId, key) {
      const k = `${taskId}|${key}`;
      if (state.paged.has(k)) return false;
      state.paged.add(k);
      return true;
    },
    async send(subject, payload) {
      state.sent.push({ subject, payload });
    },
    appUrl: () => 'https://app.example.test',
  };
  return { state, deps };
}

const base = (outcome: LandingOutcome, over: Partial<LandingAlertInput> = {}): LandingAlertInput => ({
  workspaceId: 'ws-1',
  prNumber: 42,
  headSha: 'head1',
  repoFullName: 'org/repo',
  prTitle: 'Add the thing',
  taskId: 'task-1',
  outcome,
  ...over,
});

const human = (cause: string, reason = 'because'): LandingOutcome => ({ kind: 'needs_human', cause: cause as any, reason });
const fix = (f: string, extra: object = {}): LandingOutcome => ({ kind: 'needs_fix', fix: f as any, reason: 'CI build is red', ...extra });

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'test-secret';
});
afterEach(() => {
  if (saved === undefined) delete process.env.AUTH_SECRET;
  else process.env.AUTH_SECRET = saved;
});

describe('alertOnLanding: when to page', () => {
  it('pages once for needs_human and never again across repeated sweeps', async () => {
    const { deps, state } = makeDeps();
    const input = base(human('refresh_exhausted', 'the base kept moving after 3 refreshes'));
    for (let i = 0; i < 5; i++) {
      state.now += 10 * MIN;
      await alertOnLanding(input, deps);
    }
    expect(state.sent).toHaveLength(1);
  });

  it('sends exactly one page when callers race', async () => {
    const { deps, state } = makeDeps();
    const input = base(human('fix_exhausted'));
    await Promise.all(Array.from({ length: 8 }, () => alertOnLanding(input, deps)));
    expect(state.sent).toHaveLength(1);
  });

  it('treats a new head SHA as a new situation', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('fix_exhausted')), deps);
    await alertOnLanding(base(human('fix_exhausted'), { headSha: 'head2' }), deps);
    expect(state.sent).toHaveLength(2);
  });

  it('treats a different reason on the same head as a new key', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('fix_exhausted')), deps);
    await alertOnLanding(base(human('refresh_exhausted')), deps);
    expect(state.sent).toHaveLength(2);
  });

  it.each(['human_tier', 'landing_error', 'github_unreadable', 'pr_closed'])('does not page for needs_human(%s)', async (cause) => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human(cause)), deps);
    expect(state.sent).toHaveLength(0);
  });

  it('never pages for a PR that is progressing: updating_branch and waiting_ci inside budget', async () => {
    const { deps, state } = makeDeps();
    const updating: LandingOutcome = { kind: 'updating_branch', newHeadSha: 'head2' };
    const waiting: LandingOutcome = { kind: 'waiting_ci', headSha: 'head2' };
    await alertOnLanding(base(updating, { headSha: 'head1' }), deps);
    state.now += 20 * MIN;
    await alertOnLanding(base(waiting, { headSha: 'head2' }), deps);
    state.now += 20 * MIN;
    await alertOnLanding(base(updating, { headSha: 'head2' }), deps);
    expect(state.sent).toHaveLength(0);
  });

  it('never pages for merged', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base({ kind: 'merged', sha: 'x' }), deps);
    expect(state.sent).toHaveLength(0);
  });

  it('does not page needs_fix until the pickup bound passes on the same head, then pages once', async () => {
    const { deps, state } = makeDeps();
    const input = base(fix('ci_fix', { taskId: 'fix-task' }));
    await alertOnLanding(input, deps);
    state.now += FIX_PICKUP_BOUND_MS - MIN;
    await alertOnLanding(input, deps);
    expect(state.sent).toHaveLength(0);
    state.now += 2 * MIN;
    await alertOnLanding(input, deps);
    await alertOnLanding(input, deps);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].payload.title).toContain("won't land");
  });

  it('a push (new head) restarts the needs_fix clock', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(fix('conflict')), deps);
    state.now += FIX_PICKUP_BOUND_MS - MIN;
    await alertOnLanding(base(fix('conflict'), { headSha: 'head2' }), deps);
    state.now += 2 * MIN;
    await alertOnLanding(base(fix('conflict'), { headSha: 'head2' }), deps);
    expect(state.sent).toHaveLength(0);
  });

  it('raises the invariant alarm at priority 1 when an approved PR is held past the threshold', async () => {
    const { deps, state } = makeDeps();
    const updating = base({ kind: 'updating_branch', newHeadSha: 'head1' });
    await alertOnLanding(updating, deps);
    state.now += INVARIANT_ALARM_MS - MIN;
    await alertOnLanding(base({ kind: 'waiting_ci', headSha: 'head1' }), deps);
    expect(state.sent).toHaveLength(0);
    state.now += 2 * MIN;
    await alertOnLanding(base({ kind: 'waiting_ci', headSha: 'head1' }), deps);
    await alertOnLanding(base({ kind: 'waiting_ci', headSha: 'head1' }), deps);
    expect(state.sent).toHaveLength(1);
    expect(state.sent[0].payload.priority).toBe(1);
    expect(state.sent[0].payload.message).toContain('stuck 46m');
  });

  it('does not stack the invariant alarm on a head that was already paged', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(fix('ci_fix')), deps);
    state.now += FIX_PICKUP_BOUND_MS + MIN;
    await alertOnLanding(base(fix('ci_fix')), deps);
    state.now += INVARIANT_ALARM_MS;
    await alertOnLanding(base(fix('ci_fix')), deps);
    expect(state.sent).toHaveLength(1);
  });

  it('pages with the routine priority for everything but the invariant alarm', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('size_cap')), deps);
    expect(state.sent[0].payload.priority).toBe(0);
  });

  it('cannot dedupe without an owning task, so it does not page', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('fix_exhausted'), { taskId: null }), deps);
    expect(state.sent).toHaveLength(0);
  });

  it('a failing send does not throw and does not re-page', async () => {
    const { deps, state } = makeDeps();
    deps.send = async () => {
      throw new Error('pushover down');
    };
    await alertOnLanding(base(human('fix_exhausted')), deps);
    deps.send = async (s, p) => void state.sent.push({ subject: s, payload: p });
    await alertOnLanding(base(human('fix_exhausted')), deps);
    expect(state.sent).toHaveLength(0);
  });
});

describe('alertOnLanding: copy and tap URL', () => {
  it('names the PR, the blocking reason in plain words, the cause and the time stuck', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base({ kind: 'updating_branch', newHeadSha: 'head1' }), deps);
    state.now += 50 * MIN;
    await alertOnLanding(
      base(human('refresh_exhausted', 'the base kept moving after 3 refreshes'), { approvedAt: new Date(state.now - 90 * MIN).toISOString() }),
      deps,
    );
    const { title, message, urlTitle } = state.sent[0].payload;
    expect(title).toBe("PR #42 won't land: it lost the race to the base branch (retrying next cycle)");
    expect(message).toContain('Add the thing');
    expect(message).toContain('Approved 1h 30m ago');
    expect(message).toContain('stuck 50m');
    expect(message).toContain('the base kept moving after 3 refreshes');
    expect(urlTitle).toBe('Retry landing');
  });

  it('says checks are green only when landing saw them green, and omits the stuck clause when nothing has been stuck yet', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('blocking_verdict', 'the reviewer requested changes'), { checks: 'green' }), deps);
    expect(state.sent[0].payload.message).toContain('checks green');
    expect(state.sent[0].payload.message).not.toContain('stuck');
  });

  it('never claims checks are green when landing did not see them', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('blocking_verdict', 'the reviewer requested changes')), deps);
    expect(state.sent[0].payload.message).not.toContain('checks green');
  });

  it('says checks are red for a stuck CI fix', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(fix('ci_fix'), { checks: 'green' }), deps);
    state.now += FIX_PICKUP_BOUND_MS + MIN;
    await alertOnLanding(base(fix('ci_fix'), { checks: 'green' }), deps);
    expect(state.sent[0].payload.message).toContain('checks red');
  });

  it('links a signed confirm URL whose token selects the primary action for the reason', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('fix_exhausted', 'conflict attempts are exhausted')), deps);
    const url = new URL(state.sent[0].payload.url);
    expect(url.origin).toBe('https://app.example.test');
    expect(url.pathname).toBe('/app/prs/42/act');
    const res = verifyLandingActionToken(url.searchParams.get('t'), state.now);
    expect(res.ok).toBe(true);
    expect((res as any).payload).toMatchObject({ workspaceId: 'ws-1', prNumber: 42, headSha: 'head1', action: 'conflict', reason: 'needs_human:fix_exhausted', taskId: 'task-1' });
    expect(state.sent[0].payload.urlTitle).toBe('Resolve conflicts');
  });

  it('falls back to the PR page when the deployment cannot sign', async () => {
    delete process.env.AUTH_SECRET;
    delete process.env.NEXTAUTH_SECRET;
    delete process.env.ENCRYPTION_KEY;
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('fix_exhausted')), deps);
    expect(state.sent[0].payload.url).toBe('https://app.example.test/app/prs/42/act');
  });

  it('addresses the owning workspace and task', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('size_cap')), deps);
    expect(state.sent[0].subject).toEqual({ workspaceId: 'ws-1', taskId: 'task-1', prNumber: 42 });
  });
});

describe('actionsForReason: rules only a person on GitHub can clear', () => {
  it.each(['needs_human:deny_path', 'needs_human:migration'])('%s offers only Review on GitHub, never a retry that cannot change the outcome', (reason) => {
    expect(actionsForReason(reason)).toEqual({ primary: 'review_on_github', options: ['review_on_github'] });
  });

  it.each(['needs_human:branch_protection', 'needs_human:dependency_bot', 'needs_human:unsafe_other'])('%s leads with Review on GitHub and keeps Retry landing for after the person acts', (reason) => {
    expect(actionsForReason(reason)).toEqual({ primary: 'review_on_github', options: ['review_on_github', 'retry_landing'] });
  });

  it('review on GitHub is a link, not something the server runs', () => {
    expect(overrideForAction('needs_human:deny_path', 'review_on_github')).toBeNull();
  });
});

describe('alertOnLanding: a protected-path page links straight to the diff', () => {
  it('points the tap at the PR files on GitHub and names it', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(human('deny_path', 'touches protected path (.github/workflows)')), deps);
    const { url, urlTitle, title } = state.sent[0].payload;
    expect(url).toBe('https://github.com/org/repo/pull/42/files');
    expect(urlTitle).toBe('Review on GitHub');
    expect(title).toBe("PR #42 won't land: it touches a protected path");
  });
});

describe('actionsForReason: what one tap does', () => {
  it.each([
    ['needs_fix', 'fix_stuck:ci_fix', 'ci_fix'],
    ['needs_fix', 'fix_stuck:conflict', 'conflict'],
    ['needs_fix', 'fix_stuck:re_review', 're_review'],
    ['needs_fix', 'fix_stuck:renumber_migration', 'conflict'],
    ['stuck after retries', 'needs_human:fix_exhausted', 'conflict'],
    ['superseded', 'needs_human:superseded', 'close_superseded'],
    ['blocking verdict', 'needs_human:blocking_verdict', 're_review'],
    ['lost the race', 'needs_human:refresh_exhausted', 'retry_landing'],
    ['base keeps changing the same files', 'needs_human:refresh_unsafe', 'retry_landing'],
    ['invariant', 'invariant', 'retry_landing'],
  ])('%s → primary %s', (_n, reason, primary) => {
    expect(actionsForReason(reason).primary).toBe(primary as any);
  });

  it('offers a choice when stuck after retries: dispatch fix or close as superseded', () => {
    expect(actionsForReason('needs_human:fix_exhausted').options).toEqual(['conflict', 'close_superseded']);
  });

  it('offers merge-anyway only for causes a person may override', () => {
    const offers = (r: string) => actionsForReason(r).options.includes('merge_anyway');
    expect(offers('needs_human:refresh_exhausted')).toBe(true);
    expect(offers('needs_human:size_cap')).toBe(true);
    expect(offers('needs_human:blocking_verdict')).toBe(true);
    expect(offers('needs_human:deny_path')).toBe(false);
    expect(offers('fix_stuck:ci_fix')).toBe(false);
    expect(offers('needs_human:fix_exhausted')).toBe(false);
  });

  it('maps merge-anyway to the override landPr honours for the cause', () => {
    expect(overrideForAction('needs_human:refresh_exhausted', 'merge_anyway')).toEqual({ freshness: true });
    expect(overrideForAction('needs_human:size_cap', 'merge_anyway')).toEqual({ size: true });
    expect(overrideForAction('needs_human:blocking_verdict', 'merge_anyway')).toEqual({ verdict: true });
    expect(overrideForAction('needs_human:deny_path', 'merge_anyway')).toBeNull();
    expect(overrideForAction('needs_human:refresh_exhausted', 'retry_landing')).toEqual({});
  });

  it('every reason lists its own primary action among the options', () => {
    for (const r of ['needs_human:deny_path', 'needs_human:no_owner', 'needs_human:merge_failed', 'fix_stuck:ci_fix', 'invariant', 'needs_human:superseded']) {
      const plan = actionsForReason(r);
      expect(plan.options).toContain(plan.primary);
    }
  });
});

describe('alertOnLanding: the invariant alarm follows progress, not total held age', () => {
  const waiting = (head: string): LandingOutcome => ({ kind: 'waiting_ci', headSha: head });

  /**
   * Replay: approved and held for about an hour on one head, then a base refresh
   * pushes a new head whose CI is still running, and a re-review completes on it.
   */
  it('does not page a PR that just refreshed onto a new head with pending CI, then pages once if that head stalls', async () => {
    const { deps, state } = makeDeps();
    let reviewAt: number | null = state.now - 90 * MIN;
    deps.lastReviewAt = async () => reviewAt;

    await alertOnLanding(base(waiting('head1'), { checks: 'green', outcomeReason: 'the base moved' }), deps);
    state.now += 40 * MIN;
    await alertOnLanding(base(waiting('head1'), { checks: 'green' }), deps);
    state.now += 20 * MIN; // held ~1h overall
    // Base refresh: landing reports the head it produced.
    await alertOnLanding(base({ kind: 'updating_branch', newHeadSha: 'head2' }, { headSha: 'head1' }), deps);
    state.now += 2 * MIN;
    await alertOnLanding(base(waiting('head2'), { headSha: 'head2', checks: 'pending' }), deps);
    // The re-review on the refreshed head completes.
    reviewAt = state.now;
    state.now += MIN;
    await alertOnLanding(base(waiting('head2'), { headSha: 'head2', checks: 'pending' }), deps);
    expect(state.sent).toHaveLength(0);

    // The refreshed head then makes no progress past the bound.
    state.now += INVARIANT_ALARM_MS - 2 * MIN;
    await alertOnLanding(base(waiting('head2'), { headSha: 'head2', checks: 'pending' }), deps);
    expect(state.sent).toHaveLength(0);
    state.now += 3 * MIN;
    const stalled = base(waiting('head2'), { headSha: 'head2', checks: 'pending', outcomeReason: 'CI checks are still running' });
    await alertOnLanding(stalled, deps);
    await alertOnLanding(stalled, deps);
    state.now += 30 * MIN;
    await alertOnLanding(stalled, deps);
    expect(state.sent).toHaveLength(1);

    const { title, message, priority, url } = state.sent[0].payload;
    expect(priority).toBe(1);
    expect(title).toBe("PR #42 won't land: landing has stopped making progress");
    expect(message).toContain('checks pending');
    expect(message).not.toContain('checks green');
    expect(message).toContain('no progress for 46m');
    expect(message).toContain('CI checks are still running');
    const res = verifyLandingActionToken(new URL(url).searchParams.get('t'), state.now);
    expect((res as any).payload).toMatchObject({ headSha: 'head2', reason: 'invariant' });
  });

  it('a CI transition on the same head is progress', async () => {
    const { deps, state } = makeDeps();
    await alertOnLanding(base(waiting('head1')), deps);
    state.now += 40 * MIN;
    await alertOnLanding(base(fix('ci_fix')), deps); // went red; a fix is filed
    state.now += 10 * MIN;
    await alertOnLanding(base(waiting('head1'), { checks: 'pending' }), deps); // re-run
    state.now += 10 * MIN;
    await alertOnLanding(base(waiting('head1'), { checks: 'pending' }), deps);
    expect(state.sent).toHaveLength(0);
  });

  it('a new review round on the same head is progress', async () => {
    const { deps, state } = makeDeps();
    let reviewAt: number | null = null;
    deps.lastReviewAt = async () => reviewAt;
    await alertOnLanding(base(waiting('head1')), deps);
    state.now += 40 * MIN;
    reviewAt = state.now;
    await alertOnLanding(base(waiting('head1')), deps);
    state.now += 10 * MIN;
    await alertOnLanding(base(waiting('head1')), deps);
    expect(state.sent).toHaveLength(0);
  });

  it('does not send a page for a head that is no longer live', async () => {
    const { deps, state } = makeDeps();
    deps.readLiveHead = async () => 'head2';
    await alertOnLanding(base(waiting('head1')), deps);
    state.now += INVARIANT_ALARM_MS + MIN;
    await alertOnLanding(base(waiting('head1')), deps);
    await alertOnLanding(base(human('size_cap')), deps);
    expect(state.sent).toHaveLength(0);
    // ...and the stale decision spent no dedupe key, so the live head can still page.
    deps.readLiveHead = async () => 'head1';
    await alertOnLanding(base(human('size_cap')), deps);
    expect(state.sent).toHaveLength(1);
  });
});
