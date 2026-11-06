/**
 * The DB half of PR comment follow-up, end to end with the database stood in:
 * which comments reach a live owner, exactly once, and which are recorded with
 * their reason instead.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/pr-comment-followup-store.test.ts
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// Each db.select() call resolves to the next queued result.
let selectResults: unknown[][] = [];
let selectError: Error | null = null;
function chain(): any {
  const result = () => {
    if (selectError) return Promise.reject(selectError);
    return Promise.resolve(selectResults.shift() ?? []);
  };
  let p: Promise<unknown> | null = null;
  const c: any = {};
  for (const m of ['from', 'leftJoin', 'where', 'orderBy', 'limit']) c[m] = () => c;
  c.then = (res: any, rej: any) => (p ??= result()).then(res, rej);
  return c;
}
mock.module('@buildd/core/db', () => ({ db: { select: () => chain() } }));

const gateRows: any[] = [];
mock.module('@buildd/core/gate-events', () => ({
  GATE_SLUGS: { PR_COMMENT_FOLLOWUP: 'pr_comment_followup' },
  recordGateEvent: async (row: any) => { gateRows.push(row); return 'g-1'; },
}));

const queued: Array<{ workerId: string; text: string; opts: any }> = [];
let pendingMarkers = new Set<string>();
mock.module('@/lib/system-instruction-queue', () => ({
  queueSystemInstruction: async (workerId: string, text: string, opts: any) => {
    if (pendingMarkers.has(opts.marker)) return false;
    pendingMarkers.add(opts.marker);
    queued.push({ workerId, text, opts });
    return true;
  },
}));

import { runPrCommentFollowup } from './pr-comment-followup-store';
import type { PrCommentEvent } from './pr-comment-followup';

const REPO = 'buildd-ai/buildd';

function event(over: Partial<PrCommentEvent> = {}): PrCommentEvent {
  return {
    repoFullName: REPO,
    prNumber: 42,
    commentId: 7001,
    url: `https://github.com/${REPO}/pull/42#issuecomment-7001`,
    body: 'Please also cover the empty case.',
    author: { login: 'a-maintainer', type: 'User', association: 'OWNER' },
    path: null,
    line: null,
    ...over,
  };
}

const ownerRow = (over: Record<string, unknown> = {}) => ({
  workerId: 'w-live', taskId: 't-1', workspaceId: 'ws-1', status: 'running', missionId: null,
  dataClass: 'standard', gitConfig: null, ...over,
});

beforeEach(() => {
  selectResults = [];
  selectError = null;
  gateRows.length = 0;
  queued.length = 0;
  pendingMarkers = new Set();
});

describe('runPrCommentFollowup', () => {
  test('a person with write access on a PR with a live worker: queued once and recorded as delivered', async () => {
    selectResults = [[ownerRow()], []];
    const res = await runPrCommentFollowup(event(), 'issue_comment');
    expect(res).toEqual({ outcome: 'delivered', workerId: 'w-live' });
    expect(queued).toHaveLength(1);
    expect(queued[0].workerId).toBe('w-live');
    expect(queued[0].text).toContain('> Please also cover the empty case.');
    expect(queued[0].opts).toEqual({ marker: '[pr-comment: 7001]', sensitive: false });
    expect(gateRows).toEqual([expect.objectContaining({
      gate: 'pr_comment_followup', outcome: 'accepted', workspaceId: 'ws-1', workerId: 'w-live',
      detail: expect.objectContaining({ repoFullName: REPO, commentId: 7001, delivered: true, source: 'issue_comment' }),
    })]);
  });

  test('a redelivery while the instruction is still queued: the marker stops it', async () => {
    selectResults = [[ownerRow()], [], [ownerRow()], []];
    await runPrCommentFollowup(event(), 'issue_comment');
    const again = await runPrCommentFollowup(event(), 'issue_comment');
    expect(again).toEqual({ outcome: 'skipped', reason: 'duplicate' });
    expect(queued).toHaveLength(1);
    expect(gateRows).toHaveLength(1);
  });

  test('a redelivery after the runner collected it: the ledger row stops it', async () => {
    selectResults = [[ownerRow()], [{ id: 'g-earlier' }]];
    const res = await runPrCommentFollowup(event(), 'issue_comment');
    expect(res).toEqual({ outcome: 'skipped', reason: 'duplicate' });
    expect(queued).toHaveLength(0);
    expect(gateRows).toHaveLength(0);
  });

  test('prefers the live worker over an ended one on the same PR', async () => {
    selectResults = [[ownerRow({ workerId: 'w-old', status: 'completed' }), ownerRow({ workerId: 'w-new' })], []];
    const res = await runPrCommentFollowup(event(), 'issue_comment');
    expect(res).toEqual({ outcome: 'delivered', workerId: 'w-new' });
  });

  test.each([
    ['an outside contributor', { login: 'drive-by', type: 'User', association: 'CONTRIBUTOR' }, 'no_write_access'],
    ['a bot', { login: 'ci[bot]', type: 'Bot', association: 'NONE' }, 'not_human'],
  ])('%s: queues nothing and is recorded with its reason', async (_n, author, reason) => {
    selectResults = [[ownerRow()], []];
    const res = await runPrCommentFollowup(event({ author }), 'review_comment');
    expect(res).toEqual({ outcome: 'skipped', reason });
    expect(queued).toHaveLength(0);
    expect(gateRows).toEqual([expect.objectContaining({
      outcome: 'rejected', workspaceId: 'ws-1',
      detail: expect.objectContaining({ reason, delivered: false, source: 'review_comment', authorLogin: author.login }),
    })]);
  });

  test('no worker owns the PR: nothing queued, recorded against the repo\'s workspace', async () => {
    selectResults = [[], [{ id: 'ws-repo', gitConfig: null }], []];
    const res = await runPrCommentFollowup(event(), 'issue_comment');
    expect(res).toEqual({ outcome: 'skipped', reason: 'no_live_owner' });
    expect(queued).toHaveLength(0);
    expect(gateRows).toEqual([expect.objectContaining({ outcome: 'rejected', workspaceId: 'ws-repo', workerId: null, detail: expect.objectContaining({ reason: 'no_live_owner' }) })]);
  });

  test('the owner ended: record only, as today', async () => {
    selectResults = [[ownerRow({ status: 'completed' })], []];
    const res = await runPrCommentFollowup(event(), 'issue_comment');
    expect(res).toEqual({ outcome: 'skipped', reason: 'no_live_owner' });
    expect(queued).toHaveLength(0);
    expect(gateRows[0]).toMatchObject({ outcome: 'rejected', workerId: 'w-live' });
  });

  test('another workspace with no setting is off: nothing queued, nothing recorded', async () => {
    selectResults = [[ownerRow()]];
    const res = await runPrCommentFollowup(event({ repoFullName: 'acme/widgets' }), 'issue_comment');
    expect(res).toEqual({ outcome: 'skipped', reason: 'flag_off' });
    expect(queued).toHaveLength(0);
    expect(gateRows).toHaveLength(0);
  });

  test('an explicit setting wins: buildd set to off is off, another workspace set to acting delivers', async () => {
    selectResults = [[ownerRow({ gitConfig: { prCommentFollowup: 'off' } })]];
    expect(await runPrCommentFollowup(event(), 'issue_comment')).toEqual({ outcome: 'skipped', reason: 'flag_off' });
    selectResults = [[ownerRow({ gitConfig: { prCommentFollowup: 'acting' } })], []];
    expect((await runPrCommentFollowup(event({ repoFullName: 'acme/widgets' }), 'issue_comment')).outcome).toBe('delivered');
  });

  test('recording: the would-have-sent row only', async () => {
    selectResults = [[ownerRow({ gitConfig: { prCommentFollowup: 'recording' } })]];
    const res = await runPrCommentFollowup(event(), 'issue_comment');
    expect(res).toEqual({ outcome: 'recorded', workerId: 'w-live' });
    expect(queued).toHaveLength(0);
    expect(gateRows).toEqual([expect.objectContaining({ outcome: 'warned', detail: expect.objectContaining({ delivered: false, mode: 'recording' }) })]);
  });

  test('a sensitive workspace gets the link only, and the history keeps the envelope only', async () => {
    selectResults = [[ownerRow({ dataClass: 'sensitive' })], []];
    await runPrCommentFollowup(event({ body: 'secret detail' }), 'issue_comment');
    expect(queued[0].text).not.toContain('secret detail');
    expect(queued[0].opts.sensitive).toBe(true);
  });

  test('a database failure never throws', async () => {
    selectError = new Error('db down');
    expect(await runPrCommentFollowup(event(), 'issue_comment')).toEqual({ outcome: 'skipped', reason: 'error' });
  });
});
