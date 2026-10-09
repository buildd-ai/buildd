/**
 * Who may ask for a review round (T5, docs/specs/workflow-state-kernel.md).
 *
 * - A forced request (a second round at a head that already has a verdict) is
 *   a person's call: only a `human:` actor may make one. The request route
 *   gives that actor only to a signed-in person or an OAuth session, and
 *   refuses `force` from an API key or a per-task token.
 * - ESCALATED belongs to a person. An agent's request may take a delivery out
 *   of a review escalation (`review_*`), where asking again is the point; any
 *   other escalation (unpushed work, a policy finding, a dead effect, landing)
 *   waits for a person.
 *
 * Real kernel, real Postgres and the stateful fake GitHub.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { NextRequest } from 'next/server';
import { sql } from 'drizzle-orm';
import { seam, world, type World } from './workflow-scenarios-world';
import { q } from './harness';
import { applyCommand } from '../../src/lib/workflow/kernel';

const realAuthHelpers = await import('../../src/lib/auth-helpers');
mock.module('../../src/lib/auth-helpers', () => ({ ...realAuthHelpers, getCurrentUser: async () => null }));

process.env.AUTH_SECRET ||= 'review-request-authority-test-secret-0123456789';
const reviewRoute = await import('../../src/app/api/github/pr/review/route');
const { mintTaskToken } = await import('../../src/lib/task-token');

let w: World;
afterEach(() => w?.dispose());

type Pr = Awaited<ReturnType<World['openPr']>>;

const request = (w: World, prNumber: number, o: { forced: boolean; actor: string }) => seam.requestReview({
  workspaceId: w.workspaceId, repoFullName: w.repo, prNumber, installationId: w.installationId, ...o,
});

async function serviceKey(teamId: string): Promise<{ id: string; key: string; hash: string }> {
  const key = `bld_${crypto.randomUUID().replace(/-/g, '')}`;
  const hash = createHash('sha256').update(key).digest('hex');
  const [a] = await q<{ id: string }>(sql`
    INSERT INTO accounts (type, name, api_key, team_id, level) VALUES ('service', ${`svc-${key.slice(4, 12)}`}, ${hash}, ${teamId}::uuid, 'worker') RETURNING id`);
  return { id: a.id, key, hash };
}

async function escalateAfterReview(w: World, pr: Pr): Promise<void> {
  await w.handOn(pr);
  const r1 = await w.reviewer(pr);
  await seam.recordReviewVerdict({ reviewerTask: { id: r1.id, deliveryId: pr.deliveryId, context: r1.context }, verdict: 'escalate', effectiveVerdict: 'escalate', headSha: pr.head, confidence: 0.9 });
  await w.deliver();
}

async function escalatePushUndeliverable(w: World, pr: Pr, unpushed: string): Promise<void> {
  await q(sql`UPDATE workers SET status = 'completed' WHERE id = ${pr.workerId}::uuid`);
  const ended = await seam.attemptEnded({
    task: { id: pr.ownerTaskId, workspaceId: w.workspaceId, deliveryId: pr.deliveryId, deliveryRole: 'owner', context: null },
    workerId: pr.workerId, status: 'completed', localHeadSha: unpushed, commitCount: 2, source: 'runner',
  });
  expect(ended.handled).toBe(true);
  expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_PUSH' });
  const ex = await applyCommand({ type: 'PushRecoveryExhausted', actor: 'effect:push_recovery', localHeadSha: unpushed }, { ref: { deliveryId: pr.deliveryId } });
  expect(ex.result).toBe('applied');
  expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });
}

describe('a forced review request is a person\'s call', () => {
  test('an agent\'s forced request at a head with changes requested is refused', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/cr', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    w.gh.greenCi(w.repo, pr.head, ['build', 'test']);
    await w.deliver();
    await w.verdict(pr, await w.reviewer(pr), 'request_changes', pr.head);
    expect(await w.delivery(pr)).toMatchObject({ state: 'CHANGES_REQUESTED', currentRound: 1 });

    for (const actor of ['force', 'agent:organizer', 'runner']) {
      const r = await request(w, pr.prNumber, { forced: true, actor });
      expect(r.handled && r.result.result).toBe('rejected');
    }
    expect(await w.delivery(pr)).toMatchObject({ state: 'CHANGES_REQUESTED', currentRound: 1 });
  });

  test('repeated agent requests at one head cannot outlast the round cap', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/cap', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    w.gh.greenCi(w.repo, pr.head, ['build', 'test']);
    await w.deliver();
    for (let i = 0; i < 5; i++) {
      const d = await w.delivery(pr);
      if (d.state !== 'AWAITING_REVIEW') break;
      await w.verdict(pr, await w.reviewer(pr), i < 4 ? 'request_changes' : 'approve', pr.head);
      await request(w, pr.prNumber, { forced: true, actor: 'force' });
    }
    await w.land(pr, pr.head);
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
    expect((await w.delivery(pr)).currentRound).toBe(1);
  });

  test('a person\'s forced request opens a new round at the same head', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/human', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    w.gh.greenCi(w.repo, pr.head, ['build', 'test']);
    await w.deliver();
    await w.verdict(pr, await w.reviewer(pr), 'request_changes', pr.head);
    const r = await request(w, pr.prNumber, { forced: true, actor: 'human:someone' });
    expect(r.handled && r.result.result).toBe('applied');
    expect(await w.delivery(pr)).toMatchObject({ state: 'AWAITING_REVIEW', currentRound: 2 });
  });

  test('the request route refuses force from the PR owner\'s task token and leaves the escalation with a person', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/escalated', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await escalateAfterReview(w, pr);
    expect((await w.delivery(pr)).state).toBe('ESCALATED');

    const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${w.workspaceId}::uuid`);
    const runner = await serviceKey(ws.team_id);
    await q(sql`UPDATE workers SET account_id = ${runner.id}::uuid WHERE id = ${pr.workerId}::uuid`);
    const minted = mintTaskToken({ accountId: runner.id, taskId: pr.ownerTaskId, workspaceId: w.workspaceId, keyHash: runner.hash });
    if (!minted) throw new Error('could not mint a task token');

    for (const key of [minted.token, runner.key]) {
      const res = await reviewRoute.POST(new NextRequest('http://localhost/api/github/pr/review', {
        method: 'POST',
        headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
        body: JSON.stringify({ prNumber: pr.prNumber, workspaceId: w.workspaceId, force: true }),
      }) as never);
      expect(res.status).toBe(409);
    }
    expect((await w.delivery(pr)).state).toBe('ESCALATED');
    expect((await w.tasksOf(pr, 'review')).length).toBe(1);
  }, 60_000);
});

describe('an agent request leaves a person-owned escalation alone', () => {
  test('push_undeliverable stays escalated and the PR does not land without its local commits', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/unpushed', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await escalatePushUndeliverable(w, pr, 'f'.repeat(40));
    const r = await request(w, pr.prNumber, { forced: false, actor: 'agent:organizer' });
    expect(r.handled && r.result.result).toBe('rejected');
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'push_undeliverable' });

    w.gh.greenCi(w.repo, pr.head, ['build', 'test']);
    await w.deliver();
    await w.land(pr, pr.head);
    await w.deliver();
    expect(w.gh.pr(w.repo, pr.prNumber).merged).toBe(false);
  });

  test('policy_human stays escalated and its finding still holds the head', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/policy-human', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await w.handOn(pr);
    const finding = { outcome: 'human' as const, reason: 'deny path touched', destructive: false };
    const pe = await seam.recordPolicyEvidence({ workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, source: 'preflight', finding });
    expect(pe?.result).toBe('applied');
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'policy_human' });

    const r = await request(w, pr.prNumber, { forced: false, actor: 'agent:organizer' });
    expect(r.handled && r.result.result).toBe('rejected');
    await seam.recordPolicyEvidence({ workspaceId: w.workspaceId, repoFullName: w.repo, prNumber: pr.prNumber, installationId: w.installationId, source: 'preflight', finding });
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'policy_human' });
  });

  test('a person may still take a delivery out of a non-review escalation', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/unpushed-human', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await escalatePushUndeliverable(w, pr, 'e'.repeat(40));
    const r = await request(w, pr.prNumber, { forced: false, actor: 'human:someone' });
    expect(r.handled && r.result.result).toBe('applied');
    expect((await w.delivery(pr)).state).toBe('AWAITING_REVIEW');
  });

  test('an agent request out of a review escalation still needs a head without a verdict', async () => {
    w = await world();
    const pr = await w.openPr({ branch: 'feat/review-esc', files: { 'src/a.ts': 'export const a = 2;\n' } });
    await escalateAfterReview(w, pr);
    expect(await w.delivery(pr)).toMatchObject({ state: 'ESCALATED', stateReason: 'review_escalated' });
    // Same head, not forced: the head already has a verdict.
    const same = await request(w, pr.prNumber, { forced: false, actor: 'agent:organizer' });
    expect(same.handled && same.result.result).toBe('rejected');
    expect((await w.delivery(pr)).state).toBe('ESCALATED');
  });
});
