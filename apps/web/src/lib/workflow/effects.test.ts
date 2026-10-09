/**
 * Effect runner (§10): lease/claim SQL, read-your-write gating, backoff and
 * dead-lettering. The claim race itself runs against real Postgres in
 * apps/web/tests/db/workflow-kernel.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import {
  ackEffectSql,
  claimDueEffectsSql,
  effectBackoffMs,
  effectIsCurrent,
  failEffectSql,
  insertFollowupEffectSql,
  runEffects,
  EFFECT_MAX_ATTEMPTS,
  KERNEL_ONLY_EFFECTS,
} from './effects';
import type { Exec } from './kernel';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);

describe('SQL', () => {
  test('claim takes due and lease-expired rows with SKIP LOCKED and returns the delivery/transition it must re-check', () => {
    const { sql: text, params } = render(claimDueEffectsSql(10));
    expect(text).toContain("(status = 'pending' AND not_before <= now())");
    expect(text).toContain("(status = 'delivering' AND lease_until < now())");
    expect(text).toContain('FOR UPDATE SKIP LOCKED');
    expect(text).toContain('attempt_count = e.attempt_count + 1');
    expect(text).toContain("jsonb_build_object('to_state', tr.to_state, 'to_version', tr.to_version)");
    expect(params).toEqual([10, 120_000]);
  });
  test('an inline drain claims only its own delivery\'s effects', () => {
    const { sql: text, params } = render(claimDueEffectsSql(10, 120_000, 'd1'));
    expect(text).toContain('AND delivery_id = $1::uuid');
    expect(params).toEqual(['d1', 10, 120_000]);
  });
  test('a follow-up effect is idempotent on its own dedupe key and rides the same transition', () => {
    const { sql: text, params } = render(insertFollowupEffectSql({ deliveryId: 'd1', transitionId: 't1', kind: 'push_recovery', dedupeKey: 'push_recovery:d1:L2:2', payload: { try: 2 }, delayMs: 600_000 }));
    expect(text).toContain('ON CONFLICT (dedupe_key) DO NOTHING');
    expect(params).toEqual(['d1', 't1', 'push_recovery', 'push_recovery:d1:L2:2', '{"try":2}', 600_000]);
  });
  test('ack and fail only touch a row this drain holds', () => {
    expect(render(ackEffectSql('e1', 'ok')).sql).toContain("WHERE id = $2::uuid AND status = 'delivering'");
    const pending = render(failEffectSql('e1', 'boom', 1));
    expect(pending.params).toEqual(['pending', 'boom', 15_000, 'e1']);
    expect(render(failEffectSql('e1', 'x'.repeat(900), EFFECT_MAX_ATTEMPTS)).params.slice(0, 2)).toEqual(['dead', 'x'.repeat(500)]);
  });
});

describe('backoff and gating', () => {
  test('15s doubling, capped at 30 minutes', () => {
    expect([1, 2, 3, 4].map(effectBackoffMs)).toEqual([15_000, 30_000, 60_000, 120_000]);
    expect(effectBackoffMs(20)).toBe(30 * 60_000);
  });
  test('a gated effect runs only while its transition still describes the delivery (§10.4)', () => {
    const t = { toState: 'CHANGES_REQUESTED' as const, toVersion: 4 };
    expect(effectIsCurrent({ kind: 'dispatch_fix', transition: t, delivery: { state: 'CHANGES_REQUESTED', version: 4 } })).toBe(true);
    expect(effectIsCurrent({ kind: 'dispatch_fix', transition: t, delivery: { state: 'CHANGES_REQUESTED', version: 6 } })).toBe(true);
    expect(effectIsCurrent({ kind: 'dispatch_fix', transition: t, delivery: { state: 'AWAITING_REVIEW', version: 5 } })).toBe(false);
    expect(effectIsCurrent({ kind: 'dispatch_fix', transition: null, delivery: null })).toBe(false);
    expect(effectIsCurrent({ kind: 'render_activity', transition: t, delivery: { state: 'MERGED', version: 9 } })).toBe(true);
  });
});

describe('runEffects', () => {
  const claimed = (o: Record<string, unknown>) => ({
    id: 'e1', delivery_id: 'd1', transition_id: 't1', kind: 'dispatch_fix', dedupe_key: 'k', payload: {}, attempt_count: 1,
    delivery: { state: 'CHANGES_REQUESTED', version: 4 }, transition: { to_state: 'CHANGES_REQUESTED', to_version: 4 }, ...o,
  });
  function exec(rows: unknown[], failStatus = 'pending'): { exec: Exec; seen: Array<{ tag: string; params: unknown[] }> } {
    const seen: Array<{ tag: string; params: unknown[] }> = [];
    return {
      seen,
      exec: async (q) => {
        const { sql: text, params } = render(q);
        const tag = text.split('\n')[0].replace('-- workflow:', '');
        seen.push({ tag, params });
        if (tag === 'claim_effects') return { rows };
        if (tag === 'fail_effect') return { rows: [{ id: params[3], status: failStatus }] };
        return { rows: [{ id: params[1] }] };
      },
    };
  }

  test('runs the handler and acks with its outcome', async () => {
    const x = exec([claimed({}), claimed({ id: 'e2', kind: 'render_activity' })]);
    const s = await runEffects({ exec: x.exec, handlers: { dispatch_fix: async () => ({ outcome: 'dispatched' }), render_activity: async () => ({ outcome: 'skipped:older_version' }) } });
    expect(s).toMatchObject({ claimed: 2, done: 1, skipped: 1, failed: 0 });
    expect(x.seen.filter((q) => q.tag === 'ack_effect').map((q) => q.params[0])).toEqual(['dispatched', 'skipped:older_version']);
  });
  test('a superseded gated effect is acked skipped:superseded without running', async () => {
    let ran = false;
    const x = exec([claimed({ delivery: { state: 'AWAITING_REVIEW', version: 5 } })]);
    const s = await runEffects({ exec: x.exec, handlers: { dispatch_fix: async () => { ran = true; } } });
    expect(ran).toBe(false);
    expect(s.skipped).toBe(1);
    expect(x.seen.at(-1)).toEqual({ tag: 'ack_effect', params: ['skipped:superseded', 'e1'] });
  });
  test('failures back off; dead critical effects are reported for escalation', async () => {
    const f = exec([claimed({})]);
    expect(await runEffects({ exec: f.exec, handlers: { dispatch_fix: async () => { throw new Error('gh 502'); } } })).toMatchObject({ failed: 1, dead: [] });
    const d = exec([claimed({ kind: 'merge_call', attempt_count: 8 })], 'dead');
    const escalated: unknown[] = [];
    const s = await runEffects({ exec: d.exec, handlers: {}, onDead: async (x) => { escalated.push(x); } });
    expect(s.dead).toEqual([{ id: 'e1', deliveryId: 'd1', kind: 'merge_call', critical: true, dedupeKey: expect.any(String), lastError: 'no handler for merge_call' }]);
    // 67d34094: the dead effect is handed to the escalation, not only reported.
    expect(escalated).toEqual(s.dead);
    expect(d.seen.find((q) => q.tag === 'fail_effect')!.params[1]).toBe('no handler for merge_call');
  });

  // §14 kill switch (task 8a0571d8).
  test('a delivery the kernel no longer owns never runs a kernel-only effect: acked skipped:legacy_owns', async () => {
    for (const authority of ['legacy', 'switched_off']) {
      for (const kind of KERNEL_ONLY_EFFECTS) {
        let ran = false;
        const x = exec([claimed({ kind, authority })]);
        const s = await runEffects({ exec: x.exec, handlers: { [kind]: async () => { ran = true; } } });
        expect({ authority, kind, ran, skipped: s.skipped }).toEqual({ authority, kind, ran: false, skipped: 1 });
        expect(x.seen.at(-1)).toEqual({ tag: 'ack_effect', params: ['skipped:legacy_owns', 'e1'] });
      }
    }
    expect([...KERNEL_ONLY_EFFECTS].sort()).toEqual(['merge_call', 'push_recovery', 'refresh_branch', 'renumber_migration']);
  });
  test('a switched-off delivery is released once by the drain; its committed dispatches and projections still drain', async () => {
    const x = exec([claimed({ authority: 'switched_off' }), claimed({ id: 'e2', kind: 'render_activity', authority: 'switched_off' })]);
    const ran: string[] = [];
    await runEffects({ exec: x.exec, handlers: { dispatch_fix: async () => { ran.push('dispatch_fix'); }, render_activity: async () => { ran.push('render_activity'); } } });
    expect(ran).toEqual(['dispatch_fix', 'render_activity']);
    expect(x.seen.filter((q) => q.tag === 'release_to_legacy').map((q) => q.params)).toEqual([['d1']]);
  });
  test('the claim reads who decides in the same statement, through the one switch reading', () => {
    const { sql: text } = render(claimDueEffectsSql(10));
    expect(text).toContain("WHEN d.authority = 'legacy' THEN 'legacy' WHEN (COALESCE((w.git_config)->>'workflowKernel', 'true') IN ('true', 'on')) THEN 'kernel' ELSE 'switched_off' END");
  });
});
