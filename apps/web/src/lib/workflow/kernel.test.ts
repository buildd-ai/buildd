/**
 * The CAS statement builder rendered through the real PgDialect, and the
 * command runner's read → reduce → write → re-read-once loop against a
 * scripted executor. Real-SQL behaviour (the race, atomicity) is in
 * apps/web/tests/db/workflow-kernel.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import type { ApplyDecision, Command, LivePr } from './commands';
import {
  applyCommand,
  findTransitionSql,
  loadViewSql,
  recordOnlySql,
  toDeliverySnapshot,
  transitionSql,
  type Exec,
} from './kernel';
import { reduce } from './reducer';
import type { KernelView } from './types';

const dialect = new PgDialect();
const render = (q: SQL) => dialect.sqlToQuery(q);
const live = (headSha: string): LivePr => ({ state: 'open', merged: false, headSha, headRepoFullName: 'acme/widgets', baseRef: 'dev' });

const deliveryRow = (o: Record<string, unknown> = {}) => ({
  id: 'd1', workspace_id: 'w1', owner_task_id: 't1', repo_full_name: 'acme/widgets', pr_number: 7, base_ref: 'dev',
  state: 'AWAITING_REVIEW', state_reason: null, version: '5', current_head_sha: 'H1', current_round: 1, max_rounds: 3,
  bound_attempt_id: null, resume_state: null, trunk_incident_id: null, approved_heads: [], approval_basis: null,
  composition_heads: [], ci: null, ci_head_sha: null, mergeable: null, mergeable_head_sha: null, merged_at: null,
  merge_commit_sha: null, superseded_by_pr: null, ...o,
});
const roundRow = { id: 'r1', round: 1, head_sha: 'H1', kind: 'full', status: 'queued', verdict: null, effective_verdict: null, failure_count: 0 };

const view = (): KernelView => ({
  delivery: toDeliverySnapshot(deliveryRow()),
  rounds: [{ id: 'r1', round: 1, headSha: 'H1', kind: 'full', status: 'queued', verdict: null, effectiveVerdict: null, failureCount: 0 }],
  attempts: [],
});

function decision(cmd: Command, v: KernelView = view()): ApplyDecision {
  let n = 0;
  const d = reduce(v, cmd, { newId: () => `00000000-0000-0000-0000-00000000000${++n}` });
  if (d.result !== 'apply') throw new Error(`expected apply: ${d.result}`);
  return d;
}

describe('transitionSql (§7.1: one statement)', () => {
  test('guards on id, version, allowed states, bound head and round; chains transition → effects → rounds', () => {
    const d = decision({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r1', verdict: 'request_changes', effectiveVerdict: 'request_changes', headBound: 'H1' });
    const { sql: text, params } = render(transitionSql(d, { deliveryId: 'd1', factId: 'f1' }));
    expect(text.startsWith('-- workflow:transition\nWITH d AS (\n  UPDATE workflow_deliveries SET state = $1::text, version = version + 1')).toBe(true);
    expect(text).toContain('WHERE id = $');
    expect(text).toMatch(/AND version = \$\d+::bigint AND state IN \(SELECT jsonb_array_elements_text\(\$\d+::jsonb\)\)/);
    expect(text).toMatch(/AND current_head_sha IS NOT DISTINCT FROM \$\d+::text AND current_round = \$\d+::int/);
    expect(text).toContain('t AS (\n  INSERT INTO workflow_transitions');
    expect(text).toContain('FROM d\n  RETURNING id, delivery_id, to_version');
    expect(text).toContain('e AS (\n  INSERT INTO workflow_effects');
    expect(text).toContain('FROM t, jsonb_to_recordset(');
    expect(text).toContain('ON CONFLICT (dedupe_key) DO NOTHING');
    expect(text).toContain('"r_upd_0" AS (\n  UPDATE workflow_review_rounds rr SET');
    expect(text).toContain('f AS (\n  UPDATE workflow_facts wf SET applied_transition_id = t.id');
    // The transition insert has NO ON CONFLICT: a replayed key aborts the whole statement.
    expect(text.split('INSERT INTO workflow_transitions')[1].split('),')[0]).not.toContain('ON CONFLICT');
    expect(params).toContain('CHANGES_REQUESTED');
    expect(params).toContain(5);
    expect(params).toContain('verdict:r1');
    expect(params).toContain(JSON.stringify(['AWAITING_REVIEW']));
  });

  test('a creating decision INSERTs the delivery ON CONFLICT DO NOTHING at version 1', () => {
    const d = reduce({ delivery: null, rounds: [], attempts: [] }, { type: 'DeliveryOpened', actor: 'runner', workspaceId: 'w1', ownerTaskId: 't1', requiresPr: true });
    if (d.result !== 'apply') throw new Error('apply');
    const { sql: text, params } = render(transitionSql(d));
    expect(text).toContain('d AS (\n  INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, version, max_rounds, last_transition_at)');
    expect(text).toContain('ON CONFLICT (workspace_id, owner_task_id) DO NOTHING');
    expect(text).not.toContain('e AS (');
    expect(params).toEqual(expect.arrayContaining(['w1', 't1', 'WORKING', 3]));
  });

  test('adoption inserts PR columns, the head and round 1 in the same statement', () => {
    const d = reduce({ delivery: null, rounds: [], attempts: [] }, {
      type: 'PrBound', actor: 'webhook', repoFullName: 'acme/widgets', prNumber: 7, live: live('H1'), adoption: { workspaceId: 'w1', ownerTaskId: 's1' },
    }, { newId: () => '00000000-0000-0000-0000-000000000001' });
    if (d.result !== 'apply') throw new Error('apply');
    const { sql: text } = render(transitionSql(d));
    expect(text).toMatch(/INSERT INTO workflow_deliveries \(workspace_id, owner_task_id, state, version, max_rounds, last_transition_at, "repo_full_name", "pr_number", "base_ref", "current_head_sha", "current_round"\)/);
    expect(text).toContain('r_ins AS (\n  INSERT INTO workflow_review_rounds');
  });

  test('attempt inserts, updates (with provenance append) and cancellations render', () => {
    const v = view();
    v.delivery = toDeliverySnapshot(deliveryRow({ state: 'FIXING', bound_attempt_id: 'a1' }));
    v.attempts = [{ id: 'a1', family: 'review_fix', attemptNo: 1, mode: 'agent', boundHeadSha: 'H1', triggerReason: 'r1', taskId: 'ft', status: 'running', outcome: null, maxAttempts: 3, reportedShas: [] }];
    const ended = decision({ type: 'AttemptEnded', actor: 'runner', workerId: 'w', attemptId: 'a1', outcome: 'failed', localHeadSha: 'L2', commitCount: 1, live: live('H1') }, v);
    const t1 = render(transitionSql(ended, { deliveryId: 'd1' })).sql;
    expect(t1).toContain('"a_upd_0" AS (\n  UPDATE workflow_attempts wa SET updated_at = now(), status = $');
    expect(t1).toContain('THEN wa.reported_shas ELSE array_append(wa.reported_shas,');
    expect(t1).toContain('ended_at = now()');

    const ci = decision({ type: 'CiFailedObserved', actor: 'w', headSha: 'H1', signature: 's', maxAttempts: 3 });
    const t2 = render(transitionSql(ci, { deliveryId: 'd1' })).sql;
    expect(t2).toContain('a_ins AS (\n  INSERT INTO workflow_attempts (id, delivery_id, family, attempt_no');
    expect(t2).toContain('"bound_attempt_id" = $');

    const merged = decision({ type: 'PrMerged', actor: 'w', live: { ...live('H1'), state: 'closed', merged: true, mergedAt: '2026-10-06T00:00:00Z' } });
    const t3 = render(transitionSql(merged, { deliveryId: 'd1' }));
    expect(t3.sql).toContain('"a_cancel_0" AS (\n  UPDATE workflow_attempts wa SET status = $');
    expect(t3.sql).toContain('"merged_at" = $');
    expect(t3.sql).toContain('::timestamptz');
  });

  test('array patches go through jsonb, never a JS array spread into ANY()', () => {
    const d = decision({ type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r1', verdict: 'approve', effectiveVerdict: 'approve', headBound: 'H1' });
    const { sql: text, params } = render(transitionSql(d, { deliveryId: 'd1' }));
    expect(text).toContain('"approved_heads" = ARRAY(SELECT jsonb_array_elements_text($');
    expect(text).not.toMatch(/ANY\(\(\$/);
    expect(params).toContain(JSON.stringify(['H1']));
  });

  test('a non-creating decision without a delivery id is a programming error', () => {
    const d = decision({ type: 'ReviewBudgetExhausted', actor: 'k' }, { ...view(), delivery: toDeliverySnapshot(deliveryRow({ state: 'FIXING', current_round: 3 })) });
    expect(() => transitionSql(d)).toThrow('deliveryId required');
  });
});

describe('recordOnlySql / loadViewSql / findTransitionSql', () => {
  test('record-only writes hang off a literal delivery id; empty record is null', () => {
    const q = recordOnlySql('d1', { rounds: [{ op: 'update', roundId: 'r1', whenStatus: ['superseded'], set: { verdict: 'approve', decided: true } }], attempts: [] });
    const { sql: text } = render(q!);
    expect(text).toContain('WITH src AS (SELECT $1::uuid AS delivery_id)');
    expect(text).toContain('FROM "src" s');
    expect(recordOnlySql('d1', { rounds: [], attempts: [] })).toBeNull();
  });
  test('loadViewSql selects by id, by owner task, or by repo + PR', () => {
    expect(render(loadViewSql({ deliveryId: 'd1' })).sql).toContain('WHERE d.id = $1::uuid');
    expect(render(loadViewSql({ workspaceId: 'w', ownerTaskId: 't' })).sql).toContain('d.owner_task_id = $2::uuid');
    expect(render(loadViewSql({ workspaceId: 'w', repoFullName: 'a/b', prNumber: 1 })).sql).toContain('d.pr_number = $3::int');
  });
  test('findTransitionSql looks up by (delivery, idempotency key)', () => {
    expect(render(findTransitionSql('d1', 'k')).params).toEqual(['d1', 'k']);
  });
});

// ── applyCommand against a scripted executor ────────────────────────────────

type Step = (q: string) => { rows?: unknown[] } | Error;
function scripted(steps: Step[]): { exec: Exec; seen: string[] } {
  const seen: string[] = [];
  const exec: Exec = async (q) => {
    const text = render(q).sql;
    seen.push(text.split('\n')[0]);
    const step = steps.shift();
    if (!step) throw new Error(`unexpected query: ${text.slice(0, 60)}`);
    const out = step(text);
    if (out instanceof Error) throw out;
    return out;
  };
  return { exec, seen };
}
const loaded = (o: Record<string, unknown> = {}) => () => ({ rows: [{ delivery: deliveryRow(o), rounds: [roundRow], attempts: [] }] });
const none = () => ({ rows: [] });
const verdictCmd: Command = { type: 'ReviewVerdictRecorded', actor: 'reviewer', roundId: 'r1', verdict: 'approve', effectiveVerdict: 'approve', headBound: 'H1' };

describe('applyCommand (§7.2)', () => {
  test('applied: load → key lookup → one transition statement', async () => {
    const { exec, seen } = scripted([loaded(), none, () => ({ rows: [{ transition_id: 'tr1', delivery_id: 'd1', version: '6' }] })]);
    const r = await applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec });
    expect(r).toMatchObject({ result: 'applied', transitionId: 'tr1', version: 6 });
    expect(seen).toEqual(['-- workflow:load_view', '-- workflow:find_transition', '-- workflow:transition']);
  });

  // §14 kill switch (task 8a0571d8): nothing the kernel is asked after a release becomes a transition.
  test('a delivery released to legacy is refused (legacy_owns) before any lookup or write', async () => {
    const { exec, seen } = scripted([loaded({ authority: 'legacy' })]);
    expect(await applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec })).toMatchObject({ result: 'rejected', reason: 'legacy_owns' });
    expect(seen).toEqual(['-- workflow:load_view']);
  });

  test('the transition write is guarded on authority, so a release between read and write wins', async () => {
    let text = '';
    const { exec } = scripted([loaded(), none, (q) => { text = q; return { rows: [{ transition_id: 'tr1', delivery_id: 'd1', version: '6' }] }; }]);
    await applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec });
    expect(text).toContain("authority = 'kernel'");
  });

  test('duplicate: a seen stable key returns the first transition without writing', async () => {
    const { exec, seen } = scripted([loaded(), () => ({ rows: [{ id: 'tr0' }] })]);
    expect(await applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec })).toMatchObject({ result: 'duplicate', transitionId: 'tr0' });
    expect(seen).toHaveLength(2);
  });

  test('CAS miss: re-read once and re-decide against the new state', async () => {
    const { exec } = scripted([
      loaded(), none, none, // first pass: CAS matched nothing
      loaded({ state: 'APPROVED', version: '6' }), none, // re-read: the reducer now says stale
      () => ({ rows: [{ recorded: 1 }] }), // …and keeps the verdict on its round for audit
    ]);
    expect(await applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec })).toMatchObject({ result: 'stale', reason: 'round_superseded' });
  });

  test('two CAS misses in a row answer stale(cas_conflict) — never a blind third try', async () => {
    const { exec } = scripted([loaded(), none, none, loaded(), none, none, loaded()]);
    expect(await applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec })).toMatchObject({ result: 'stale', reason: 'cas_conflict' });
  });

  test('a unique violation (replayed key) is treated as a CAS miss, then duplicate', async () => {
    const err = Object.assign(new Error('x'), { cause: { code: '23505' } });
    const { exec } = scripted([loaded(), none, () => err, loaded({ version: '6' }), () => ({ rows: [{ id: 'tr0' }] })]);
    expect(await applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec })).toMatchObject({ result: 'duplicate', transitionId: 'tr0' });
  });

  test('other database errors propagate', async () => {
    const { exec } = scripted([loaded(), none, () => new Error('connection reset')]);
    await expect(applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec })).rejects.toThrow('connection reset');
  });

  test('stale with a record writes the audit rows; rejected without record writes nothing', async () => {
    const late = scripted([loaded({ current_head_sha: 'H2', current_round: 2 }), none, () => ({ rows: [{ recorded: 1 }] })]);
    expect(await applyCommand(verdictCmd, { ref: { deliveryId: 'd1' }, exec: late.exec })).toMatchObject({ result: 'stale' });
    expect(late.seen.at(-1)).toBe('-- workflow:record');
    const rej = scripted([loaded()]);
    expect(await applyCommand({ type: 'ReviewRequested', actor: 'k', headSha: 'H0', live: live('H0') }, { ref: { deliveryId: 'd1' }, exec: rej.exec })).toMatchObject({ result: 'rejected', reason: 'round_head_not_current' });
  });

  test('reducer duplicate passes through; opening races resolve to duplicate', async () => {
    const dup = scripted([loaded(), none]);
    expect(await applyCommand({ type: 'DeliveryOpened', actor: 'r', workspaceId: 'w1', ownerTaskId: 't1', requiresPr: true }, { exec: dup.exec })).toMatchObject({ result: 'duplicate', reason: 'delivery_exists' });
    const race = scripted([none, none, loaded({ state: 'WORKING' })]);
    expect(await applyCommand({ type: 'DeliveryOpened', actor: 'r', workspaceId: 'w1', ownerTaskId: 't1', requiresPr: true }, { exec: race.exec })).toMatchObject({ result: 'duplicate', reason: 'delivery_exists' });
    const adopt = scripted([none, none, loaded()]);
    expect(await applyCommand({ type: 'PrBound', actor: 'w', repoFullName: 'acme/widgets', prNumber: 7, live: live('H1'), adoption: { workspaceId: 'w1', ownerTaskId: 's1' } }, { exec: adopt.exec })).toMatchObject({ result: 'duplicate' });
  });

  test('a command that is not self-locating needs a ref', async () => {
    await expect(applyCommand(verdictCmd, { exec: async () => ({ rows: [] }) })).rejects.toThrow('a delivery ref is required');
  });
});
