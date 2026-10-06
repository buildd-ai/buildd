import { describe, it, expect, mock } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';

mock.module('@buildd/core/db', () => ({ db: {} }));
const {
  taskCompletedEvent,
  taskFailedEvent,
  taskNeedsInputEvent,
  prMergedEvent,
  prCiFailedEvent,
  prSubjectKey,
  recordEventSql,
  recordEvent,
  createSubscriptionSql,
  createSubscription,
  cancelSubscription,
  listSubscriptions,
  listUndelivered,
  markDeliveredSql,
  markDelivered,
  resolveExpiresAt,
  ONE_SHOT_DEFAULT_TTL_MS,
  STANDING_DEFAULT_TTL_MS,
  MAX_TTL_MS,
} = await import('./subscriptions');

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
/** Whitespace-collapsed SQL text, so assertions are not tied to indentation. */
const text = (q: SQL) => render(q).sql.replace(/\s+/g, ' ');

const now = new Date('2026-09-27T12:00:00.000Z');
const TASK = '11111111-1111-4111-8111-111111111111';
const WORKER_A = '22222222-2222-4222-8222-222222222222';
const WORKER_B = '33333333-3333-4333-8333-333333333333';
const USER = '44444444-4444-4444-8444-444444444444';
const WS = '55555555-5555-4555-8555-555555555555';

/** Records every statement and returns canned rows. */
function recorder(rows: unknown[] = []) {
  const calls: SQL[] = [];
  const exec = async (q: SQL) => { calls.push(q); return { rows }; };
  return { calls, exec };
}

// ── Dedupe ───────────────────────────────────────────────────────────────────

describe('dedupe: the same fact from two code paths is one ledger row', () => {
  it('task.completed from the worker PATCH and from the merged-PR auto-complete share one key', () => {
    // Worker route knows the worker; the webhook knows a (possibly different)
    // row carrying the PR. The fact is "this task completed" either way.
    const fromWorkerRoute = taskCompletedEvent({ taskId: TASK, workerId: WORKER_A });
    const fromWebhook = taskCompletedEvent({ taskId: TASK, workerId: WORKER_B });
    expect(fromWorkerRoute.dedupeKey).toBe(fromWebhook.dedupeKey);
  });

  it('pr.merged from the webhook and the reconcile sweep share one key, case-insensitive on the repo', () => {
    const webhook = prMergedEvent({ repoFullName: 'Acme/Widgets', prNumber: 42 });
    const sweep = prMergedEvent({ repoFullName: 'acme/widgets', prNumber: 42 });
    expect(webhook.dedupeKey).toBe(sweep.dedupeKey);
    expect(webhook.subjectKey).toBe(prSubjectKey('acme/widgets', 42));
  });

  it('a repeated needs-input PATCH with the same question is one key; a new question is another', () => {
    const a = taskNeedsInputEvent({ taskId: TASK, workerId: WORKER_A, prompt: 'Which DB?' });
    const again = taskNeedsInputEvent({ taskId: TASK, workerId: WORKER_A, prompt: 'Which DB?' });
    const other = taskNeedsInputEvent({ taskId: TASK, workerId: WORKER_A, prompt: 'Which region?' });
    expect(a.dedupeKey).toBe(again.dedupeKey);
    expect(a.dedupeKey).not.toBe(other.dedupeKey);
    // The question text is not stored in the key.
    expect(a.dedupeKey).not.toContain('Which DB');
  });

  it('a failure is keyed per attempt (worker), so a retry that fails again is a new event', () => {
    expect(taskFailedEvent({ taskId: TASK, workerId: WORKER_A }).dedupeKey)
      .not.toBe(taskFailedEvent({ taskId: TASK, workerId: WORKER_B }).dedupeKey);
  });

  it('a failure carries its reason in the payload, cut to short text; none when absent', () => {
    expect(taskFailedEvent({ taskId: TASK, workerId: WORKER_A, reason: 'Release failed: CI red' }).payload.reason)
      .toBe('Release failed: CI red');
    expect(taskFailedEvent({ taskId: TASK, workerId: WORKER_A, reason: 'x'.repeat(500) }).payload.reason).toHaveLength(200);
    expect('reason' in taskFailedEvent({ taskId: TASK, workerId: WORKER_A }).payload).toBe(false);
  });

  it('CI red is keyed per head SHA', () => {
    const one = prCiFailedEvent({ repoFullName: 'acme/widgets', prNumber: 42, headSha: 'abc' });
    const same = prCiFailedEvent({ repoFullName: 'acme/widgets', prNumber: 42, headSha: 'abc' });
    const next = prCiFailedEvent({ repoFullName: 'acme/widgets', prNumber: 42, headSha: 'def' });
    expect(one.dedupeKey).toBe(same.dedupeKey);
    expect(one.dedupeKey).not.toBe(next.dedupeKey);
  });

  it('the ledger write is one INSERT ... SELECT that does nothing on (subscription_id, dedupe_key) conflict', () => {
    const q = text(recordEventSql(taskCompletedEvent({ taskId: TASK }), now));
    expect(q).toContain('insert into "notification_deliveries"');
    expect(q).toContain('on conflict ("subscription_id", "dedupe_key") do nothing');
    expect(q).toContain('returning');
  });

  it('two calls with the same event bind the same dedupe key, and only returned rows count as new', async () => {
    const { calls, exec } = recorder([]);
    const e = taskCompletedEvent({ taskId: TASK, workerId: WORKER_A });
    const first = await recordEvent(e, { exec, now: () => now });
    const second = await recordEvent(taskCompletedEvent({ taskId: TASK, workerId: WORKER_B }), { exec, now: () => now });
    expect(first.recorded).toBe(0);
    expect(second.recorded).toBe(0);
    // The payload may differ (first writer wins); the conflict key does not.
    expect(render(calls[0]).params).toContain(e.dedupeKey);
    expect(render(calls[1]).params).toContain(e.dedupeKey);
  });

  it('never throws: a DB error is logged and reported as zero rows', async () => {
    const exec = async () => { throw new Error('boom'); };
    const r = await recordEvent(taskCompletedEvent({ taskId: TASK }), { exec, now: () => now });
    expect(r).toEqual({ recorded: 0, error: true });
  });
});

// ── Scoping ──────────────────────────────────────────────────────────────────

describe('scoping: a subscription only matches subjects its owner can see', () => {
  const task = text(recordEventSql(taskCompletedEvent({ taskId: TASK }), now));
  const pr = text(recordEventSql(prMergedEvent({ repoFullName: 'acme/widgets', prNumber: 42 }), now));

  it('matches on subject kind + key and the event type', () => {
    expect(task).toContain('s."subject_kind" =');
    expect(task).toContain('s."subject_key" =');
    expect(task).toContain('= any(s."event_types")');
  });

  it('a task event resolves the task\'s own workspace and requires it to be in the subscription\'s team', () => {
    expect(task).toContain('from "tasks" t join "workspaces" w on w."id" = t."workspace_id"');
    expect(task).toContain('w."team_id" = s."team_id"');
    expect(task).toContain('(s."workspace_id" is null or s."workspace_id" = w."id")');
  });

  it('a PR event only reaches a subscription whose workspace points at that repo', () => {
    expect(pr).toContain('w."id" = s."workspace_id"');
    expect(pr).toContain('w."team_id" = s."team_id"');
    // Repo identity comes only from the github_repos FK (follows renames).
    expect(pr).toContain('from "github_repos" gr where gr."id" = w."github_repo_id" and lower(gr."full_name") =');
    expect(render(recordEventSql(prMergedEvent({ repoFullName: 'Acme/Widgets', prNumber: 42 }), now)).params)
      .toContain('acme/widgets');
  });

  it('a workspace whose only link to the repo is the free-text repo column gets nothing', () => {
    // The column is not an identity: it is free text, often a URL, and does
    // not follow renames. Neither create nor event matching may read it.
    const create = text(createSubscriptionSql({
      owner: { userId: USER },
      subject: { kind: 'pr', workspaceId: WS, repoFullName: 'acme/widgets', prNumber: 42 },
      eventTypes: ['pr.merged'],
      createdVia: 'chat',
    }, now));
    for (const q of [pr, create]) {
      expect(q).not.toContain('w."repo"');
      expect(q).not.toContain('regexp_replace');
      expect(q).toContain('gr."id" = w."github_repo_id"');
    }
  });

  it('a person owner must still be a member of the subject\'s team at event time', () => {
    expect(task).toContain('s."owner_user_id" is not null and exists (select 1 from "team_members" tm where tm."team_id" = w."team_id" and tm."user_id" = s."owner_user_id")');
  });

  it('an agent (task) owner must run in the same team, and gets the restricted-workspace rule accounts get', () => {
    expect(task).toContain('s."owner_task_id" is not null and exists (select 1 from "tasks" ot join "workspaces" ow on ow."id" = ot."workspace_id" where ot."id" = s."owner_task_id" and ow."team_id" = w."team_id"');
    // Its own workspace, an open one, or one its claiming account is linked to.
    expect(task).toContain('ow."id" = w."id" or w."access_mode" = \'open\' or exists (select 1 from "account_workspaces" taw where taw."account_id" = ot."claimed_by" and taw."workspace_id" = w."id")');
  });

  it('an account (MCP session) owner needs the team, and an explicit link to a restricted workspace', () => {
    expect(task).toContain('oa."team_id" = w."team_id"');
    expect(task).toContain('w."access_mode" = \'open\' or exists (select 1 from "account_workspaces" aw where aw."account_id" = oa."id" and aw."workspace_id" = w."id")');
  });

  it('create applies the same visibility rule, and a conversation must belong to the owner', () => {
    const q = text(createSubscriptionSql({
      owner: { userId: USER },
      subject: { kind: 'task', taskId: TASK },
      eventTypes: ['task.completed'],
      conversationId: '66666666-6666-4666-8666-666666666666',
      createdVia: 'chat',
    }, now));
    expect(q).toContain('insert into "subscriptions"');
    expect(q).toContain('exists (select 1 from "team_members" tm where tm."team_id" = w."team_id" and tm."user_id" = ');
    expect(q).toContain('from "conversations" c where c."id" = ');
    expect(q).toContain('c."created_by_user_id" = ');
  });

  it('create for a PR takes the team from the named workspace and requires the workspace to point at the repo', () => {
    const q = text(createSubscriptionSql({
      owner: { userId: USER },
      subject: { kind: 'pr', workspaceId: WS, repoFullName: 'acme/widgets', prNumber: 42 },
      eventTypes: ['pr.merged'],
      createdVia: 'chat',
    }, now));
    expect(q).toContain('select w."team_id", w."id"');
    expect(q).toContain('from "github_repos" gr where gr."id" = w."github_repo_id"');
  });

  it('create returns null when the owner cannot see the subject (no row inserted)', async () => {
    const { exec } = recorder([]);
    const r = await createSubscription({
      owner: { userId: USER },
      subject: { kind: 'task', taskId: TASK },
      eventTypes: ['task.completed'],
      createdVia: 'chat',
    }, { exec, now: () => now });
    expect(r).toBeNull();
  });

  it('create rejects an event type that does not belong to the subject kind', async () => {
    const { exec } = recorder([]);
    await expect(createSubscription({
      owner: { userId: USER },
      subject: { kind: 'task', taskId: TASK },
      eventTypes: ['pr.merged' as any],
      createdVia: 'chat',
    }, { exec, now: () => now })).rejects.toThrow(/pr\.merged/);
  });

  it('list / cancel / listUndelivered / markDelivered are all scoped to the owner', () => {
    const owner = { userId: USER };
    const cases: Array<[string, (exec: any) => Promise<unknown>]> = [
      ['list', (exec) => listSubscriptions(owner, { exec, now: () => now })],
      ['cancel', (exec) => cancelSubscription(owner, 'sub-1', { exec, now: () => now })],
      ['undelivered', (exec) => listUndelivered(owner, { exec })],
      ['mark', (exec) => markDelivered(owner, 'del-1', { route: 'conversation' }, { exec, now: () => now })],
    ];
    return Promise.all(cases.map(async ([name, run]) => {
      const { calls, exec } = recorder([]);
      await run(exec);
      const r = render(calls[0]);
      expect({ name, has: r.sql.includes('"owner_user_id" = $') }).toEqual({ name, has: true });
      expect(r.params).toContain(USER);
    }));
  });

  it('owner kinds map to their own column, never another', () => {
    const { calls, exec } = recorder([]);
    return listUndelivered({ taskId: TASK }, { exec }).then(() => {
      const q = render(calls[0]).sql;
      expect(q).toContain('"owner_task_id" = $');
      expect(q).not.toContain('"owner_user_id" = $');
    });
  });
});

// ── One-shot ────────────────────────────────────────────────────────────────

describe('one-shot: a watch ends after its first delivery', () => {
  const mark = text(markDeliveredSql({ userId: USER }, 'del-1', { route: 'conversation' }, now));

  it('takes the one-shot subscription first, then marks the row only if it won the claim', () => {
    const claim = mark.indexOf('claimed as ( update "subscriptions" s set "ended_at" =');
    const marked = mark.indexOf('marked as ( update "notification_deliveries" d set "status" = \'delivered\'');
    expect(claim).toBeGreaterThan(-1);
    expect(marked).toBeGreaterThan(claim);
    expect(mark).toContain('"end_reason" = \'delivered\'');
    expect(mark).toContain('s."lifetime" = \'one_shot\' and s."ended_at" is null');
    // A standing watch has nothing to claim; a one-shot needs the claim.
    expect(mark).toContain('(target."lifetime" = \'standing\' or exists (select 1 from claimed))');
    expect(mark).toContain('d."status" = \'pending\'');
  });

  it('concurrency: of two markDelivered calls on one one-shot, only the one that ends the watch marks', () => {
    // Postgres re-checks an UPDATE's WHERE on the row it waited for, so the
    // second claim on the same subscription sees ended_at set and returns no
    // row; its delivery update is gated on that claim and writes nothing.
    // (Also run for real against Postgres: see the PR body.)
    for (const del of ['del-1', 'del-2']) {
      const q = text(markDeliveredSql({ userId: USER }, del, { route: 'conversation' }, now));
      expect(q).toContain('s."ended_at" is null');
      expect(q).toContain('exists (select 1 from claimed)');
    }
  });

  it('the winner folds the watch\'s other pending rows into coalesced', () => {
    expect(mark).toContain('siblings as ( update "notification_deliveries" d set "status" = \'coalesced\'');
    expect(mark).toContain('from claimed where d."subscription_id" = claimed."id" and d."status" = \'pending\' and d."id" <>');
  });

  it('an ended subscription matches no new events', () => {
    expect(text(recordEventSql(taskCompletedEvent({ taskId: TASK }), now))).toContain('s."ended_at" is null');
  });

  it('markDelivered reports whether the row was newly marked and whether the watch ended', async () => {
    const { exec } = recorder([{ marked: 1, ended: 1 }]);
    expect(await markDelivered({ userId: USER }, 'del-1', { route: 'conversation' }, { exec, now: () => now }))
      .toEqual({ marked: true, subscriptionEnded: true });
    const again = recorder([{ marked: 0, ended: 0 }]);
    expect(await markDelivered({ userId: USER }, 'del-1', { route: 'conversation' }, { exec: again.exec, now: () => now }))
      .toEqual({ marked: false, subscriptionEnded: false });
  });

  it('an ended watch (delivered one-shot or cancelled) has no undelivered rows', () => {
    const { calls, exec } = recorder([]);
    return listUndelivered({ userId: USER }, { exec }).then(() => {
      const q = text(calls[0]);
      expect(q).toContain('d."status" = \'pending\'');
      expect(q).toContain('s."ended_at" is null');
    });
  });
});

// ── Expiry by time ───────────────────────────────────────────────────────────

describe('expiry by time', () => {
  it('an expired subscription matches no event: expires_at is compared to the caller\'s clock', () => {
    const r = render(recordEventSql(taskCompletedEvent({ taskId: TASK }), now));
    expect(r.sql.replace(/\s+/g, ' ')).toContain('s."expires_at" >');
    expect(r.params).toContain(now.toISOString());
  });

  it('list hides expired subscriptions', () => {
    const { calls, exec } = recorder([]);
    return listSubscriptions({ userId: USER }, { exec, now: () => now }).then(() => {
      expect(text(calls[0])).toContain('s."expires_at" >');
    });
  });

  it('defaults: one-shot 7 days, standing 30 days', () => {
    expect(ONE_SHOT_DEFAULT_TTL_MS).toBe(7 * 86_400_000);
    expect(STANDING_DEFAULT_TTL_MS).toBe(30 * 86_400_000);
    expect(resolveExpiresAt({ lifetime: 'one_shot' }, now).getTime()).toBe(now.getTime() + ONE_SHOT_DEFAULT_TTL_MS);
    expect(resolveExpiresAt({ lifetime: 'standing' }, now).getTime()).toBe(now.getTime() + STANDING_DEFAULT_TTL_MS);
  });

  it('clamps to the 90-day hard max, and refuses an expiry in the past', () => {
    expect(MAX_TTL_MS).toBe(90 * 86_400_000);
    const far = new Date(now.getTime() + 365 * 86_400_000);
    expect(resolveExpiresAt({ lifetime: 'standing', expiresAt: far }, now).getTime()).toBe(now.getTime() + MAX_TTL_MS);
    expect(() => resolveExpiresAt({ lifetime: 'one_shot', expiresAt: new Date(now.getTime() - 1) }, now)).toThrow(/future/);
  });
});

// ── The origin conversation's record ────────────────────────────────────────

describe('listUnpostedForConversation: what the origin conversation still has to show', () => {
  const CONV = '66666666-6666-4666-8666-666666666666';
  it('is the person\'s own watches from this conversation, pending or delivered by any route, not yet posted', async () => {
    const { listUnpostedForConversationSql } = await import('./subscriptions');
    const r = render(listUnpostedForConversationSql({ userId: USER }, CONV, 50));
    const q = r.sql.replace(/\s+/g, ' ');
    expect(q).toContain('s."owner_user_id" = $1::uuid');
    expect(q).toContain('s."conversation_id" = $2::uuid');
    expect(r.params.slice(0, 2)).toEqual([USER, CONV]);
    expect(q).toContain(`d."status" in ('pending', 'delivered')`);
    // Posted once: the event message's id is the ledger row id.
    expect(q).toContain('not exists (select 1 from "conversation_messages" m where m."id" = d."id")');
  });

  it('a one-shot posts its first row only, and a cancelled watch posts nothing more', async () => {
    const { listUnpostedForConversationSql } = await import('./subscriptions');
    const q = text(listUnpostedForConversationSql({ userId: USER }, CONV, 50));
    expect(q).toContain(`(s."ended_at" is null or s."end_reason" = 'delivered')`);
    expect(q).toContain(`s."lifetime" = 'standing' or d."id" = ( select d2."id"`);
    expect(q).toContain('order by (d2."status" = \'delivered\') desc, d2."created_at" asc');
  });

  it('clamps the page size', async () => {
    const { listUnpostedForConversation } = await import('./subscriptions');
    const { calls, exec } = recorder([]);
    await listUnpostedForConversation({ userId: USER }, CONV, { exec, limit: 10_000 });
    expect(render(calls[0]).params).toContain(200);
  });
});

describe('conversationOwnersSql: who the watch-pending flag goes to', () => {
  const SUB_A = '88888888-8888-4888-8888-888888888888';
  const SUB_B = '99999999-9999-4999-8999-999999999999';
  it('is exactly these subscriptions, person owners only, and only watches that post into a conversation', async () => {
    const { conversationOwnersSql } = await import('./subscriptions');
    const r = render(conversationOwnersSql([SUB_A, SUB_B]));
    const q = r.sql.replace(/\s+/g, ' ');
    expect(q).toContain('select distinct s."owner_user_id" as "userId" from "subscriptions" s');
    expect(q).toContain('s."id" in ($1::uuid, $2::uuid)');
    expect(r.params).toEqual([SUB_A, SUB_B]);
    // Each scoping predicate is load-bearing: an agent-owned watch or one with
    // no origin conversation has no open tab to wake.
    expect(q).toContain('s."owner_user_id" is not null');
    expect(q).toContain('s."conversation_id" is not null');
  });
});
