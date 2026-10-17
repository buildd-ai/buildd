/**
 * Opening a mission's integration PR gives it a kernel delivery
 * (docs/specs/workflow-kernel-library.md §6: "A mission's integration PR is a
 * delivery of role mission"; #4686 is the mission PR that never had one).
 *
 * The real `openMissionIntegrationPr` runs against the stateful fake GitHub
 * (POST /pulls, compare, the PR's own webhook), and the `opened` webhook goes
 * through the real webhook route, signature and all. Nothing in between is
 * stubbed except the leaves that are not GitHub (the reviewer prompt, the
 * dispatch wake, notifications), which the shared world installs.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { createHmac } from 'crypto';
import { sql } from 'drizzle-orm';
import { world, type World, type WebhookDelivery } from './workflow-scenarios-world';
import { q } from './harness';

process.env.GITHUB_APP_WEBHOOK_SECRET = 'mission-pr-delivery-secret';
const { NextRequest } = await import('next/server');
const route = await import('../../src/app/api/github/webhook/route');
const { openMissionIntegrationPr } = await import('../../src/lib/mission-pr');
const { kernelDeliveryOfPr } = await import('../../src/lib/workflow/seam');

let w: World;
let off: () => void;
beforeEach(() => {
  // Every webhook the fake raises goes to the real route, as GitHub would send it.
  w = undefined as unknown as World;
});
afterEach(() => { off?.(); w?.dispose(); });

async function toRoute(d: WebhookDelivery): Promise<void> {
  const body = JSON.stringify(d.payload);
  const sig = `sha256=${createHmac('sha256', process.env.GITHUB_APP_WEBHOOK_SECRET!).update(body).digest('hex')}`;
  const res = await route.POST(new NextRequest('http://localhost/api/github/webhook', {
    method: 'POST',
    headers: { 'x-hub-signature-256': sig, 'x-github-event': d.name, 'x-github-delivery': d.id, 'content-type': 'application/json' },
    body,
  }));
  expect(res.status).toBeLessThan(500);
}

/** An opted-in mission whose one deliverable task already merged into the integration branch. */
async function seedShippableMission(world: World, opts: { mergePolicy?: object | null } = {}) {
  const [ws] = await q<{ team_id: string }>(sql`SELECT team_id FROM workspaces WHERE id = ${world.workspaceId}::uuid`);
  const branch = `mission/ship-it-${Math.random().toString(36).slice(2, 10)}`;
  const [m] = await q<{ id: string }>(sql`INSERT INTO missions (team_id, workspace_id, title, working_branch, integration_branch_enabled, merge_policy)
    VALUES (${ws.team_id}::uuid, ${world.workspaceId}::uuid, 'Ship it', ${branch}, true, ${opts.mergePolicy ? JSON.stringify(opts.mergePolicy) : null}::jsonb) RETURNING id`);
  world.gh.createBranch(world.repo, branch, 'dev');
  world.gh.push(world.repo, branch, { 'src/feature.ts': 'export const feature = 1;\n' }, { message: 'feat: the mission work' });
  const [t] = await q<{ id: string }>(sql`INSERT INTO tasks (workspace_id, mission_id, title, status, task_class)
    VALUES (${world.workspaceId}::uuid, ${m.id}::uuid, 'the work', 'completed', 'work') RETURNING id`);
  await q(sql`INSERT INTO workers (workspace_id, task_id, name, runner, branch, status, pr_number, pr_url, pr_base_ref, merged_at, pr_lifecycle_status)
    VALUES (${world.workspaceId}::uuid, ${t.id}::uuid, 'w', 'test', 'buildd/the-work', 'completed', 900, ${`https://github.com/${world.repo}/pull/900`}, ${branch}, now(), 'merged')`);
  return { missionId: m.id, branch };
}

describe('opening the mission integration PR', () => {
  for (const [label, mergePolicy] of [
    ['the default merge policy (auto-threshold)', null],
    ['a mission human-review policy', { tier: 'human' }],
    ['a mission agent-review policy', { tier: 'agent-review', agentReview: { reviewerRole: 'reviewer' } }],
  ] as const) {
    test(`creates a kernel delivery owned by the mission's PR task, under ${label}`, async () => {
      w = await world();
      off = w.gh.onWebhook(toRoute);
      const { missionId, branch } = await seedShippableMission(w, { mergePolicy });

      const opened = await openMissionIntegrationPr(missionId);
      expect(opened).toMatchObject({ ok: true, created: true });
      if (!opened.ok) return;
      await w.deliver();

      // The delivery is the PR's: found by PR, bound to it, owned by the mission's bookkeeping task.
      const found = await kernelDeliveryOfPr({ workspaceId: w.workspaceId, prNumber: opened.prNumber });
      expect(found?.deliveryId).toBeTruthy();
      const [d] = await q<{ owner_task_id: string; pr_number: number; repo_full_name: string; base_ref: string; authority: string; state: string }>(
        sql`SELECT owner_task_id, pr_number, repo_full_name, base_ref, authority, state FROM workflow_deliveries WHERE id = ${found!.deliveryId}::uuid`);
      expect(d).toMatchObject({ pr_number: opened.prNumber, repo_full_name: w.repo, base_ref: 'dev', authority: 'kernel' });
      const [owner] = await q<{ mission_id: string; task_class: string; title: string; delivery_id: string | null; delivery_role: string | null }>(
        sql`SELECT mission_id, task_class, title, delivery_id, delivery_role FROM tasks WHERE id = ${d.owner_task_id}::uuid`);
      expect(owner).toMatchObject({ mission_id: missionId, task_class: 'bookkeeping' });
      expect(owner.title).toStartWith('Ship mission:');
      expect(owner.delivery_role).toBe('owner');

      // Exactly one delivery for the mission's PR, and the mission's delivery record names the same PR.
      const rows = await q(sql`SELECT id FROM workflow_deliveries WHERE workspace_id = ${w.workspaceId}::uuid AND pr_number = ${opened.prNumber}`);
      expect(rows).toHaveLength(1);
      const [epoch] = await q<{ pr_number: number; branch: string }>(sql`SELECT pr_number, branch FROM workflow_mission_epochs WHERE mission_id = ${missionId}::uuid`);
      expect(epoch).toMatchObject({ pr_number: opened.prNumber, branch });
    });
  }

  test('the delivery does not wait for the opened webhook: opened with the webhook still queued, the PR already has one', async () => {
    w = await world();
    const { missionId } = await seedShippableMission(w);
    const opened = await openMissionIntegrationPr(missionId);
    if (!opened.ok) throw new Error(`mission PR did not open: ${JSON.stringify(opened)}`);
    expect(w.gh.pendingWebhooks().some((h) => h.name === 'pull_request')).toBe(true);
    const found = await kernelDeliveryOfPr({ workspaceId: w.workspaceId, prNumber: opened.prNumber });
    expect(found?.deliveryId).toBeTruthy();
    const [d] = await q<{ authority: string; state: string }>(sql`SELECT authority, state FROM workflow_deliveries WHERE id = ${found!.deliveryId}::uuid`);
    expect(d.authority).toBe('kernel');
    expect(['WORKING', 'AWAITING_REVIEW', 'APPROVED']).toContain(d.state);
  });

  test('a second call, and a redelivered opened webhook, leave the one delivery', async () => {
    w = await world();
    off = w.gh.onWebhook(toRoute);
    const { missionId } = await seedShippableMission(w);
    const first = await openMissionIntegrationPr(missionId);
    if (!first.ok) throw new Error(`mission PR did not open: ${JSON.stringify(first)}`);
    await w.deliver();
    const again = await openMissionIntegrationPr(missionId);
    expect(again).toMatchObject({ ok: true, created: false, prNumber: first.prNumber });
    await w.deliver();
    const rows = await q(sql`SELECT id FROM workflow_deliveries WHERE workspace_id = ${w.workspaceId}::uuid`);
    expect(rows).toHaveLength(1);
  });
});
