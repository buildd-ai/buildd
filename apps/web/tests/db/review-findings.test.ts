/**
 * Durable findings on real Postgres (docs/specs/workflow-state-kernel.md §13.13,
 * AC-24, AC-25, AC-30, AC-31, AC-37): the CAS statement writes findings and
 * outbox effects atomically, a replay adds nothing, and the landing authority
 * reads them back through the real SQL.
 */
import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { sql } from 'drizzle-orm';

mock.module('@/lib/dispatch-authority', () => ({ announceTaskCreated: async () => {}, wakeTask: async () => {} }));

import { applyCommand, loadView } from '../../src/lib/workflow/kernel';
import { landingAuthority } from '../../src/lib/workflow/landing-authority';
import { __handlers } from '../../src/lib/workflow/review-findings-effects';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const REPO = 'acme/findings';
let workspaceId: string;
let pr = 7000;

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace({}));
}, 30_000);

/** A delivery waiting on its round-1 review at head H1. */
async function seedDelivery(state = 'AWAITING_REVIEW', extra: { approved?: boolean } = {}) {
  const ownerTaskId = await seedTask(workspaceId);
  const prNumber = ++pr;
  const [d] = await q<{ id: string }>(sql`INSERT INTO workflow_deliveries
    (workspace_id, owner_task_id, repo_full_name, pr_number, base_ref, state, version, current_head_sha, current_round, max_rounds, approved_heads, approval_basis)
    VALUES (${workspaceId}::uuid, ${ownerTaskId}::uuid, ${REPO}, ${prNumber}, 'dev', ${state}, 5, 'H1', 1, 3,
      ${extra.approved ? sql`ARRAY['H1']::text[]` : sql`ARRAY[]::text[]`}, ${extra.approved ? 'verdict' : null})
    RETURNING id`);
  const [r] = await q<{ id: string }>(sql`INSERT INTO workflow_review_rounds (delivery_id, round, head_sha, kind, status)
    VALUES (${d.id}::uuid, 1, 'H1', 'full', 'reviewing') RETURNING id`);
  return { deliveryId: d.id, roundId: r.id, prNumber, ownerTaskId };
}

const request = (roundId: string, findings = [{ path: 'copy.ts', line: 4, text: 'wrong copy' }, { path: 'copy.ts', line: 9, text: 'also wrong' }]) => ({
  type: 'ReviewVerdictRecorded' as const, actor: 'reviewer:t', roundId, verdict: 'request_changes' as const,
  effectiveVerdict: 'request_changes' as const, headBound: 'H1', findings,
});

describe('AC-24: findings are written with the transition and survive', () => {
  test('a request-changes verdict persists two findings and queues the fix and the GitHub status together', async () => {
    const s = await seedDelivery();
    const res = await applyCommand(request(s.roundId), { ref: { deliveryId: s.deliveryId } });
    expect(res.result).toBe('applied');
    const view = await loadView({ deliveryId: s.deliveryId });
    expect(view.delivery?.state).toBe('CHANGES_REQUESTED');
    expect(view.findings?.map((f) => [f.path, f.line, f.status, f.round, f.reviewedHeadSha])).toEqual([['copy.ts', 4, 'open', 1, 'H1'], ['copy.ts', 9, 'open', 1, 'H1']]);
    const kinds = (await q<{ kind: string }>(sql`SELECT kind FROM workflow_effects WHERE delivery_id = ${s.deliveryId}::uuid ORDER BY kind`)).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(['dispatch_fix', 'post_review', 'publish_verdict_status']));
  });

  test('a replayed verdict is a duplicate and adds nothing', async () => {
    const s = await seedDelivery();
    await applyCommand(request(s.roundId), { ref: { deliveryId: s.deliveryId } });
    const again = await applyCommand(request(s.roundId), { ref: { deliveryId: s.deliveryId } });
    expect(['duplicate', 'stale']).toContain(again.result);
    expect((await loadView({ deliveryId: s.deliveryId })).findings).toHaveLength(2);
    const [{ n }] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM workflow_review_findings WHERE delivery_id = ${s.deliveryId}::uuid`);
    expect(n).toBe('2');
  });

  test('the unique key makes a concurrent double insert collapse to one row', async () => {
    const s = await seedDelivery();
    await applyCommand(request(s.roundId, [{ path: 'a.ts', line: 1, text: 'one' }]), { ref: { deliveryId: s.deliveryId } });
    await q(sql`INSERT INTO workflow_review_findings (delivery_id, round, reviewed_head_sha, path, line, text, fingerprint)
      SELECT delivery_id, round, reviewed_head_sha, path, line, text, fingerprint FROM workflow_review_findings WHERE delivery_id = ${s.deliveryId}::uuid
      ON CONFLICT (delivery_id, round, fingerprint) DO NOTHING`);
    expect((await loadView({ deliveryId: s.deliveryId })).findings).toHaveLength(1);
  });
});

describe('AC-30/AC-31: the landing authority reads the real rows', () => {
  test('refuses while a finding is open, passes once a person waived it', async () => {
    const s = await seedDelivery();
    await applyCommand(request(s.roundId), { ref: { deliveryId: s.deliveryId } });
    const asked = () => landingAuthority({ repoFullName: REPO, prNumber: s.prNumber, workspaceId, door: 'auto_merge', headSha: 'H1' });
    expect(await asked()).toMatchObject({ blocks: true, kind: 'open_findings' });

    expect((await applyCommand({ type: 'FindingsWaived', actor: 'agent:x', scope: 'all', reason: 'x' }, { ref: { deliveryId: s.deliveryId } })).result).toBe('rejected');
    expect(await asked()).toMatchObject({ blocks: true });

    const w = await applyCommand({ type: 'FindingsWaived', actor: 'human:max', scope: 'all', reason: 'accepted, tracked elsewhere' }, { ref: { deliveryId: s.deliveryId } });
    expect(w.result).toBe('applied');
    const closed = (await loadView({ deliveryId: s.deliveryId })).findings!;
    expect(closed.every((f) => f.status === 'waived' && (f.resolution as { actor?: string }).actor === 'human:max')).toBe(true);
    // CHANGES_REQUESTED still gates the review state, so a door keeps refusing until it is re-reviewed or approved.
    expect(await asked()).toMatchObject({ blocks: true, kind: 'review_unresolved' });
    const [t] = await q<{ bypass: Record<string, unknown> }>(sql`SELECT bypass FROM workflow_transitions WHERE delivery_id = ${s.deliveryId}::uuid AND command = 'FindingsWaived'`);
    expect(t.bypass).toMatchObject({ kind: 'finding_waiver', actor: 'human:max' });
  });

  test('a landing request over an open finding is rejected and writes nothing', async () => {
    const s = await seedDelivery('APPROVED', { approved: true });
    await q(sql`INSERT INTO workflow_review_findings (delivery_id, round, reviewed_head_sha, path, text, fingerprint) VALUES (${s.deliveryId}::uuid, 1, 'H0', 'a.ts', 'open', 'fp-land')`);
    const res = await applyCommand({
      type: 'LandingRequested', actor: 'kernel', door: 'auto', headSha: 'H1',
      live: { state: 'open', merged: false, headSha: 'H1', headRepoFullName: REPO, baseRef: 'dev' }, rails: { passed: true },
    }, { ref: { deliveryId: s.deliveryId } });
    expect(res).toMatchObject({ result: 'rejected', reason: 'open_findings' });
    expect((await loadView({ deliveryId: s.deliveryId })).delivery?.state).toBe('APPROVED');
    const [{ n }] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM workflow_effects WHERE delivery_id = ${s.deliveryId}::uuid AND kind = 'merge_call'`);
    expect(n).toBe('0');
  });
});

describe('AC-37: a merge outside buildd records the truth', () => {
  test('MERGED over open findings, findings stay open, one follow-up task, replay adds none', async () => {
    const s = await seedDelivery();
    await applyCommand(request(s.roundId), { ref: { deliveryId: s.deliveryId } });
    const merged = {
      type: 'PrMerged' as const, actor: 'webhook', mergedBy: { kind: 'person' as const, login: 'someone' },
      live: { state: 'closed' as const, merged: true, headSha: 'H1', headRepoFullName: REPO, baseRef: 'dev', mergedAt: '2026-10-17T00:00:00Z', mergeCommitSha: 'M1' },
    };
    expect((await applyCommand(merged, { ref: { deliveryId: s.deliveryId } })).result).toBe('applied');
    const view = await loadView({ deliveryId: s.deliveryId });
    expect(view.delivery?.state).toBe('MERGED');
    expect(view.findings?.every((f) => f.status === 'open')).toBe(true);
    const [t] = await q<{ evidence: Record<string, unknown> }>(sql`SELECT evidence FROM workflow_transitions WHERE delivery_id = ${s.deliveryId}::uuid AND command = 'PrMerged'`);
    expect(t.evidence).toMatchObject({ reviewClass: 'merged_over_open_findings', mergedBy: { kind: 'person', login: 'someone' } });
    expect((await applyCommand(merged, { ref: { deliveryId: s.deliveryId } })).result).not.toBe('applied');

    const fx = (await q<{ id: string; delivery_id: string; payload: Record<string, unknown> }>(sql`SELECT id, delivery_id, payload FROM workflow_effects WHERE delivery_id = ${s.deliveryId}::uuid AND kind = 'file_merged_findings_followup'`));
    expect(fx).toHaveLength(1);
    const claimed = { id: fx[0].id, deliveryId: s.deliveryId, transitionId: 't', kind: 'file_merged_findings_followup', dedupeKey: 'k', payload: fx[0].payload, attemptCount: 1 } as never;
    expect(await __handlers.fileMergedFindingsFollowup(claimed)).toEqual({ outcome: 'ok' });
    expect(await __handlers.fileMergedFindingsFollowup(claimed)).toEqual({ outcome: 'ok:task_exists' });
    const [{ n }] = await q<{ n: string }>(sql`SELECT count(*)::text AS n FROM tasks WHERE context->>'mergedOverFindingsOfDelivery' = ${s.deliveryId}`);
    expect(n).toBe('1');
  });
});
