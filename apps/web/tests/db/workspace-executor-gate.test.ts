/**
 * The workspace executor gate, against real Postgres. A host runner's
 * cross-workspace poll must not take a task from a workspace whose work runs in
 * the cloud (it beats the cold-starting container and the container then finds
 * nothing), and a cloud claim must not take a host-only workspace's task. The
 * gate is a jsonb CASE inside the claim WHERE, which a mocked `db` cannot see.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { and, inArray, sql } from 'drizzle-orm';
import { db } from '@buildd/core/db';
import { tasks } from '@buildd/core/db/schema';
import { CLOUD_DISPATCH_EVENTS } from '@buildd/shared';
import { workspaceExecutorGate } from '@/app/api/workers/claim/workspace-executor-gate';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

const cloudWebhook = { url: 'https://cloud.example/dispatch', token: 't', enabled: true, events: [...CLOUD_DISPATCH_EVENTS] };

async function seed(opts: { webhookConfig?: Record<string, unknown> | null; executor?: unknown }): Promise<string> {
  const { workspaceId } = await seedWorkspace({ webhookConfig: opts.webhookConfig ?? null });
  if (opts.executor !== undefined) {
    await q(sql`UPDATE workspaces SET git_config = ${JSON.stringify({ defaultBranch: 'main', executor: opts.executor })}::jsonb WHERE id = ${workspaceId}::uuid`);
  }
  return seedTask(workspaceId);
}

let t: Record<string, string>;
beforeAll(async () => {
  assertDbConfigured();
  const cases: Record<string, Parameters<typeof seed>[0]> = {
    derivedCloud: { webhookConfig: cloudWebhook },
    disabledWebhook: { webhookConfig: { ...cloudWebhook, enabled: false } },
    partialEvents: { webhookConfig: { ...cloudWebhook, events: ['task.created', 'task.unblocked'] } },
    plain: {},
    explicitCloud: { executor: 'cloud' },
    explicitHost: { executor: 'host' },
    explicitAnyOverWebhook: { webhookConfig: cloudWebhook, executor: 'any' },
    explicitHostOverWebhook: { webhookConfig: cloudWebhook, executor: 'host' },
    unknownValue: { webhookConfig: cloudWebhook, executor: 'bogus' },
  };
  const ids = await Promise.all(Object.values(cases).map(seed));
  t = Object.fromEntries(Object.keys(cases).map((k, i) => [k, ids[i]]));
}, 30_000);

async function claimable(claim: 'host' | 'cloud'): Promise<string[]> {
  const rows = await db.query.tasks.findMany({
    where: and(inArray(tasks.id, Object.values(t)), workspaceExecutorGate(claim)),
    columns: { id: true },
  });
  const byId = new Map(Object.entries(t).map(([k, v]) => [v, k]));
  return rows.map(r => byId.get(r.id)!).sort();
}

describe('workspaceExecutorGate', () => {
  test('a host claim does not return a task from a cloud-dispatched workspace', async () => {
    expect(await claimable('host')).toEqual([
      'disabledWebhook', 'explicitAnyOverWebhook', 'explicitHost', 'explicitHostOverWebhook', 'partialEvents', 'plain',
    ]);
  });

  test('a cloud claim skips host-only workspaces and takes everything else', async () => {
    expect(await claimable('cloud')).toEqual([
      'derivedCloud', 'disabledWebhook', 'explicitAnyOverWebhook', 'explicitCloud', 'partialEvents', 'plain', 'unknownValue',
    ]);
  });

  test('the gate is two-valued, so the explicit-claim probe can name it', async () => {
    const rows = await db.select({ id: tasks.id, ok: sql<boolean>`(${workspaceExecutorGate('host')})` })
      .from(tasks).where(inArray(tasks.id, Object.values(t)));
    for (const r of rows) expect(typeof r.ok === 'boolean' || r.ok === 't' || r.ok === 'f').toBe(true);
  });
});
