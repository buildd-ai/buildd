// Relay queue storage (docs/specs/local-runner-provider.md §3, §4): every
// transition is one guarded statement. The SQL is rendered with the real
// dialect and asserted as text, and the row-level outcomes are driven through a
// scripted exec, so the WHERE guards (the atomicity) are observable.
import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  awaitRelayJob,
  cancelRelayJob,
  claimRelayJobs,
  completeRelayJob,
  enqueueRelayJob,
  progressRelayJob,
  sweepRelayJobs,
  type RelayExec,
} from '../model-relay';

const dialect = new PgDialect();
const render = (q: SQL) => {
  const out = dialect.sqlToQuery(q);
  return { sql: out.sql.replace(/\s+/g, ' ').trim(), params: out.params };
};

/** An exec that records every statement and answers each from a script (by its leading comment tag). */
function scripted(answers: Record<string, Array<Record<string, unknown>[]> | ((params: unknown[]) => Record<string, unknown>[])>) {
  const calls: Array<{ tag: string; sql: string; params: unknown[] }> = [];
  const exec: RelayExec = async (q) => {
    const { sql, params } = render(q);
    const tag = /^-- (relay:\w+)/.exec(sql)?.[1] ?? 'untagged';
    calls.push({ tag, sql, params });
    const answer = answers[tag];
    if (!answer) return { rows: [] };
    if (typeof answer === 'function') return { rows: answer(params) };
    return { rows: answer.shift() ?? [] };
  };
  return { exec, calls, byTag: (tag: string) => calls.filter(c => c.tag === tag) };
}

const TEAM = '11111111-1111-4111-8111-111111111111';
const RUNNER = '22222222-2222-4222-8222-222222222222';
const JOB = '33333333-3333-4333-8333-333333333333';
const OWNER = `${RUNNER}:lease-1`;
const embedPayload = { inputs: ['a', 'b'], inputType: 'document' as const, dimensions: 768 };

describe('enqueue', () => {
  it('inserts a queued row with the surface deadline and the kind default attempts', async () => {
    const s = scripted({ 'relay:enqueue': [[{ id: JOB, deadline_at: '2026-11-14T00:00:20.000Z' }]] });
    const out = await enqueueRelayJob({ teamId: TEAM, runnerId: RUNNER, kind: 'embed', surface: 'query', namespace: 'ws:memory', model: 'nomic-embed-text', payload: embedPayload }, s.exec);
    expect(out).toEqual({ ok: true, id: JOB, deadlineAt: new Date('2026-11-14T00:00:20.000Z') });
    const call = s.byTag('relay:enqueue')[0]!;
    expect(call.sql).toContain('INSERT INTO model_relay_jobs');
    expect(call.params).toContain(2); // embed max_attempts
    expect(call.params).toContain(20); // query deadline, seconds
  });

  it('refuses an oversize chat payload before any row is written (payload_too_large)', async () => {
    const s = scripted({});
    const out = await enqueueRelayJob({ teamId: TEAM, runnerId: RUNNER, kind: 'chat', surface: 'chat', model: 'llama3.1:8b', payload: { messages: [{ content: 'x'.repeat(1_000_001) }] } }, s.exec);
    expect(out).toEqual({ ok: false, code: 'payload_too_large', message: expect.stringContaining('cap is 1000000') });
    expect(s.calls).toHaveLength(0);
  });

  it('refuses a payload of the wrong shape for its kind', async () => {
    const s = scripted({});
    const out = await enqueueRelayJob({ teamId: TEAM, runnerId: RUNNER, kind: 'embed', surface: 'ingest', model: 'm', payload: { messages: [] } as never }, s.exec);
    expect(out.ok).toBe(false);
    expect(s.calls).toHaveLength(0);
  });
});

describe('claim (§4.1, AC-9)', () => {
  it('is one UPDATE over a SKIP LOCKED subselect scoped to team + runner + model, chat first', async () => {
    const s = scripted({ 'relay:claim': [[{ id: JOB, kind: 'chat', surface: 'chat', model: 'llama', payload: '{"messages":[]}', deadline_at: '2026-11-14T00:05:00.000Z', lease_expires_at: '2026-11-14T00:01:00.000Z' }]] });
    const jobs = await claimRelayJobs({ teamId: TEAM, runnerId: RUNNER, models: ['llama', 'nomic-embed-text'], max: 2 }, s.exec);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ id: JOB, kind: 'chat', model: 'llama', payload: { messages: [] }, leaseOwner: `${RUNNER}:${jobs[0]!.leaseId}` });
    const { sql, params } = s.byTag('relay:claim')[0]!;
    expect(s.calls).toHaveLength(1);
    expect(sql).toContain("SET status = 'leased'");
    expect(sql).toContain('attempts = j.attempts + 1');
    expect(sql).toContain('WHERE team_id = $');
    expect(sql).toContain('AND runner_id = $');
    expect(sql).toContain("status = 'queued' AND not_before <= now() AND deadline_at > now()");
    expect(sql).toContain('AND model IN ($5::text, $6::text)');
    expect(sql).toContain("ORDER BY CASE kind WHEN 'chat' THEN 0 ELSE 1 END, created_at");
    expect(sql).toContain('FOR UPDATE SKIP LOCKED');
    expect(sql).toContain("AND j.status = 'queued'");
    expect(params).toContain(TEAM);
    expect(params).toContain(RUNNER);
    expect(params).toContain('llama');
    expect(params).toContain('nomic-embed-text');
  });

  it('a runner serving no model claims nothing and touches no row', async () => {
    const s = scripted({});
    expect(await claimRelayJobs({ teamId: TEAM, runnerId: RUNNER, models: [] }, s.exec)).toEqual([]);
    expect(s.calls).toHaveLength(0);
  });
});

describe('complete (§4.2, AC-11, AC-12)', () => {
  const leasedEmbed = { kind: 'embed', payload: JSON.stringify(embedPayload), attempts: 1, max_attempts: 2, status: 'leased', lease_owner: OWNER };
  const ledgerRow = { team_id: TEAM, runner_id: RUNNER, kind: 'embed', model: 'nomic-embed-text' };

  it('stores a valid embed result as done, guarded by the lease owner, and writes the ledger', async () => {
    const s = scripted({ 'relay:read_leased': [[leasedEmbed]], 'relay:complete': [[ledgerRow]] });
    const vectors = [Array(768).fill(0.1), Array(768).fill(0.2)];
    const out = await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: true, result: { vectors, dimensions: 768, model: 'nomic-embed-text', promptTokens: 12, durationMs: 80 } }, s.exec);
    expect(out).toEqual({ outcome: 'done' });
    const upd = s.byTag('relay:complete')[0]!;
    expect(upd.sql).toContain("WHERE id = $");
    expect(upd.sql).toContain("AND status = 'leased' AND lease_owner = $");
    expect(upd.params[0]).toBe('done');
    const ledger = s.byTag('relay:usage')[0]!;
    expect(ledger.sql).toContain('INSERT INTO model_relay_usage_daily');
    expect(ledger.sql).toContain('ON CONFLICT (day, team_id, runner_id, kind, model)');
    expect(ledger.params).toEqual([TEAM, RUNNER, 'embed', 'nomic-embed-text', 0, 12, 0, 80]);
  });

  it('a wrong-sized vector fails the job with dimension_mismatch and stores no result', async () => {
    const s = scripted({ 'relay:read_leased': [[leasedEmbed]], 'relay:complete': [[ledgerRow]] });
    const out = await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: true, result: { vectors: [Array(768).fill(0), Array(1024).fill(0)], dimensions: 768, model: 'm' } }, s.exec);
    expect(out).toMatchObject({ outcome: 'failed', error: { code: 'dimension_mismatch' } });
    const upd = s.byTag('relay:complete')[0]!;
    expect(upd.params[0]).toBe('failed');
    expect(upd.params[1]).toBeNull(); // result
    expect(JSON.parse(upd.params[2] as string).code).toBe('dimension_mismatch');
    expect(s.byTag('relay:usage')[0]!.params[4]).toBe(1); // errors
  });

  it('another owner posting a result is a conflict and changes nothing (AC-11)', async () => {
    const s = scripted({ 'relay:read_leased': [[{ ...leasedEmbed, lease_owner: `${RUNNER}:other` }]] });
    const out = await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: true, result: { vectors: [], dimensions: 768, model: 'm' } }, s.exec);
    expect(out).toEqual({ outcome: 'conflict' });
    expect(s.byTag('relay:complete')).toHaveLength(0);
  });

  it('a result for a terminal job is gone (HTTP 410 for the route)', async () => {
    const s = scripted({ 'relay:read_leased': [[{ ...leasedEmbed, status: 'cancelled' }]] });
    expect(await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: false, error: { code: 'timeout', message: 'x' } }, s.exec)).toEqual({ outcome: 'gone', status: 'cancelled' });
    const missing = scripted({});
    expect(await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: false, error: { code: 'timeout', message: 'x' } }, missing.exec)).toEqual({ outcome: 'gone', status: null });
  });

  it('a retryable failure with attempts left is queued again with backoff and no ledger row', async () => {
    const s = scripted({ 'relay:read_leased': [[leasedEmbed]], 'relay:complete': [[ledgerRow]] });
    const out = await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: false, error: { code: 'ollama_error', message: 'upstream 503', httpStatus: 503 } }, s.exec);
    expect(out).toEqual({ outcome: 'requeued', notBeforeMs: 10_000 }); // 2^1 * 5 s
    expect(s.byTag('relay:complete')[0]!.params[0]).toBe('queued');
    expect(s.byTag('relay:usage')).toHaveLength(0);
  });

  it('a final failure, or a retryable one with no attempts left, is failed and counted', async () => {
    const final = scripted({ 'relay:read_leased': [[leasedEmbed]], 'relay:complete': [[ledgerRow]] });
    expect(await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: false, error: { code: 'model_missing', message: 'no such tag' } }, final.exec)).toMatchObject({ outcome: 'failed' });
    expect(final.byTag('relay:usage')).toHaveLength(1);
    const exhausted = scripted({ 'relay:read_leased': [[{ ...leasedEmbed, attempts: 2 }]], 'relay:complete': [[ledgerRow]] });
    expect(await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: false, error: { code: 'timeout', message: 't' } }, exhausted.exec)).toMatchObject({ outcome: 'failed' });
  });

  it('a lease that moved between the read and the write is a conflict', async () => {
    const s = scripted({ 'relay:read_leased': [[leasedEmbed], [{ ...leasedEmbed, lease_owner: 'someone:else' }]], 'relay:complete': [[]] });
    expect(await completeRelayJob({ id: JOB, leaseOwner: OWNER, ok: false, error: { code: 'timeout', message: 't' } }, s.exec)).toEqual({ outcome: 'conflict' });
  });
});

describe('progress and cancel', () => {
  it('progress renews the lease under the owner guard and appends partial text', async () => {
    const s = scripted({ 'relay:progress': [[{ ok: 1 }]] });
    expect(await progressRelayJob({ id: JOB, leaseOwner: OWNER, partialText: 'Hel' }, s.exec)).toBe(true);
    const { sql, params } = s.byTag('relay:progress')[0]!;
    expect(sql).toContain('SET lease_expires_at = now() + make_interval');
    expect(sql).toContain("jsonb_set(coalesce(result, '{}'::jsonb), '{partialText}'");
    expect(sql).toContain("AND status = 'leased' AND lease_owner = $");
    expect(params).toContain('Hel');
    const stale = scripted({});
    expect(await progressRelayJob({ id: JOB, leaseOwner: OWNER }, stale.exec)).toBe(false);
  });

  it('cancel only moves an open job, and counts it as an error', async () => {
    const s = scripted({ 'relay:cancel': [[{ team_id: TEAM, runner_id: RUNNER, kind: 'chat', model: 'llama' }]] });
    expect(await cancelRelayJob(JOB, s.exec)).toBe(true);
    expect(s.byTag('relay:cancel')[0]!.sql).toContain("WHERE id = $2::uuid AND status IN ('queued', 'leased')");
    expect(s.byTag('relay:usage')[0]!.params.slice(0, 5)).toEqual([TEAM, RUNNER, 'chat', 'llama', 1]);
    const terminal = scripted({});
    expect(await cancelRelayJob(JOB, terminal.exec)).toBe(false);
    expect(terminal.byTag('relay:usage')).toHaveLength(0);
  });
});

describe('sweep (§3.5, AC-5..AC-8)', () => {
  it('expires past-deadline rows, requeues lapsed leases with attempts left, fails the rest, prunes old terminal rows', async () => {
    const s = scripted({
      'relay:sweep_expire': [[{ team_id: TEAM, runner_id: RUNNER, kind: 'embed', model: 'm' }]],
      'relay:sweep_requeue': [[{ id: 'a' }, { id: 'b' }]],
      'relay:sweep_lost': [[{ team_id: TEAM, runner_id: null, kind: 'chat', model: 'c' }]],
      'relay:sweep_prune': [[{ gone: 1 }, { gone: 1 }, { gone: 1 }]],
    });
    expect(await sweepRelayJobs({}, s.exec)).toEqual({ expired: 1, requeued: 2, lost: 1, pruned: 3 });
    expect(s.calls.map(c => c.tag)).toEqual(['relay:sweep_expire', 'relay:sweep_requeue', 'relay:sweep_lost', 'relay:sweep_prune', 'relay:usage']);

    const expire = s.byTag('relay:sweep_expire')[0]!;
    expect(expire.sql).toContain("SET status = 'expired'");
    expect(expire.sql).toContain("WHERE status IN ('queued', 'leased') AND deadline_at <= now()");
    expect(expire.sql).toContain("CASE WHEN status = 'leased' THEN $1::jsonb ELSE $2::jsonb END");
    expect(JSON.parse(expire.params[0] as string).code).toBe('lease_lost');
    expect(JSON.parse(expire.params[1] as string).code).toBe('runner_offline');

    const requeue = s.byTag('relay:sweep_requeue')[0]!;
    expect(requeue.sql).toContain("SET status = 'queued'");
    expect(requeue.sql).toContain('power(2, attempts)');
    expect(requeue.sql).not.toContain('attempts = attempts + 1');
    expect(requeue.sql).toContain("WHERE status = 'leased' AND lease_expires_at < now() AND attempts < max_attempts AND deadline_at > now()");

    const lost = s.byTag('relay:sweep_lost')[0]!;
    expect(lost.sql).toContain("SET status = 'failed'");
    expect(lost.sql).toContain("WHERE status = 'leased' AND lease_expires_at < now() AND attempts >= max_attempts");
    expect(JSON.parse(lost.params[0] as string).code).toBe('lease_lost');

    const prune = s.byTag('relay:sweep_prune')[0]!;
    expect(prune.sql).toContain("DELETE FROM model_relay_jobs WHERE status IN ('done', 'failed', 'expired', 'cancelled') AND finished_at < now() - make_interval");
    expect(prune.params).toEqual([24 * 60 * 60]);

    // Only the row whose runner still exists is attributed (the lost row's runner is gone).
    expect(s.byTag('relay:usage')).toHaveLength(1);
    expect(s.byTag('relay:usage')[0]!.params.slice(0, 5)).toEqual([TEAM, RUNNER, 'embed', 'm', 1]);
  });
});

describe('await (§4.3): never throws, cancels at the deadline', () => {
  const base = { id: JOB, kind: 'chat', deadline_at: '2026-11-14T00:05:00.000Z' };

  it('returns the result once the job is done and forwards partial text as it grows', async () => {
    const s = scripted({
      'relay:get': [
        [{ ...base, status: 'leased', result: JSON.stringify({ partialText: 'Hel' }), error: null }],
        [{ ...base, status: 'leased', result: JSON.stringify({ partialText: 'Hello' }), error: null }],
        [{ ...base, status: 'done', result: JSON.stringify({ text: 'Hello.', finishReason: 'stop' }), error: null }],
      ],
    });
    const deltas: string[] = [];
    const out = await awaitRelayJob(JOB, { deadlineAt: new Date('2026-11-14T00:05:00Z'), now: () => 0, sleep: async () => {}, onPartialText: d => deltas.push(d) }, s.exec);
    expect(out).toEqual({ ok: true, result: { text: 'Hello.', finishReason: 'stop' } });
    expect(deltas).toEqual(['Hel', 'lo']);
  });

  it('a failed job answers with its stored code', async () => {
    const s = scripted({ 'relay:get': [[{ ...base, status: 'failed', result: null, error: JSON.stringify({ code: 'model_missing', message: 'gone' }) }]] });
    expect(await awaitRelayJob(JOB, { deadlineAt: new Date(0), sleep: async () => {} }, s.exec)).toEqual({ ok: false, code: 'model_missing', message: 'gone' });
  });

  it('past the deadline with the job still open: cancels and answers runner_offline', async () => {
    const s = scripted({ 'relay:get': (() => [{ ...base, status: 'queued', result: null, error: null }]) as never, 'relay:cancel': [[{ team_id: TEAM, runner_id: RUNNER, kind: 'chat', model: 'c' }]] });
    let t = 0;
    const out = await awaitRelayJob(JOB, { deadlineAt: new Date(1_000), now: () => (t += 600), sleep: async () => {} }, s.exec);
    expect(out).toEqual({ ok: false, code: 'runner_offline', message: expect.stringContaining('deadline') });
    expect(s.byTag('relay:cancel')).toHaveLength(1);
  });

  it('a database error ends the wait as runner_offline instead of throwing', async () => {
    const exec: RelayExec = async () => { throw new Error('connection reset'); };
    expect(await awaitRelayJob(JOB, { deadlineAt: new Date(0), sleep: async () => {} }, exec)).toEqual({ ok: false, code: 'runner_offline', message: 'connection reset' });
  });
});
