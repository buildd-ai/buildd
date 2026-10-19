/**
 * The floor's sweep of dead effects on real Postgres: a dead effect on a finished delivery (or for a head
 * that is no longer current) is closed as superseded with its reason; a dead effect on a live delivery
 * stays dead and is reported. Dead is never resolved silently.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';
import { liveDeadEffects, sweepDeadEffects } from '../../src/lib/workflow/dead-effect-sweep';

let workspaceId: string;
const HEAD = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
let pr = 700_000 + Math.floor(Math.random() * 100_000);

async function delivery(state: string): Promise<{ id: string; transitionId: string }> {
  const t = await seedTask(workspaceId);
  const [d] = await q<{ id: string }>(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, version, authority, repo_full_name, pr_number, current_head_sha)
    VALUES (${workspaceId}::uuid, ${t}::uuid, ${state}, 1, 'kernel', 'acme/dead-effects', ${pr++}, ${HEAD}) RETURNING id`);
  const [tr] = await q<{ id: string }>(sql`INSERT INTO workflow_transitions (delivery_id, from_version, to_version, from_state, to_state, command, idempotency_key, actor, evidence)
    VALUES (${d.id}::uuid, 0, 1, NULL, ${state}, 'open_delivery', ${`k-${d.id}`}, 'system:test', '{}'::jsonb) RETURNING id`);
  return { id: d.id, transitionId: tr.id };
}
async function deadEffect(d: { id: string; transitionId: string }, kind: string, payload: Record<string, unknown> = {}): Promise<string> {
  const [e] = await q<{ id: string }>(sql`INSERT INTO workflow_effects (delivery_id, transition_id, kind, dedupe_key, payload, status, attempt_count, last_error)
    VALUES (${d.id}::uuid, ${d.transitionId}::uuid, ${kind}, ${`${kind}:${d.id}:${Math.random()}`}, ${JSON.stringify(payload)}::jsonb, 'dead', 6, 'boom') RETURNING id`);
  return e.id;
}
const row = async (id: string) => (await q<{ status: string; outcome: string | null; last_error: string | null }>(sql`SELECT status, outcome, last_error FROM workflow_effects WHERE id = ${id}::uuid`))[0]!;

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId } = await seedWorkspace());
});

describe('sweepDeadEffects', () => {
  test('a dead effect on a merged delivery is closed as superseded, with its reason', async () => {
    const d = await delivery('MERGED');
    const id = await deadEffect(d, 'publish_landing_status', { version: 1 });
    const s = await sweepDeadEffects();
    expect(s.closed).toBeGreaterThanOrEqual(1);
    const r = await row(id);
    expect(r.status).toBe('done');
    expect(r.outcome).toBe('superseded: delivery merged');
    expect(r.last_error).toBe('boom');
  });

  test('a dead effect for a head that is no longer current is closed as superseded', async () => {
    const d = await delivery('FIXING');
    const stale = await deadEffect(d, 'dispatch_ci_fix', { headSha: 'f'.repeat(40) });
    const current = await deadEffect(d, 'dispatch_ci_fix', { headSha: HEAD });
    await sweepDeadEffects();
    expect((await row(stale)).outcome).toBe('superseded: head no longer current');
    expect((await row(current)).status).toBe('dead');
  });

  test('a dead effect on a live delivery stays dead and is reported', async () => {
    const d = await delivery('AWAITING_REVIEW');
    const id = await deadEffect(d, 'publish_landing_status', { version: 1 });
    const s = await sweepDeadEffects();
    expect((await row(id)).status).toBe('dead');
    expect(s.live).toBeGreaterThanOrEqual(1);
    const live = await liveDeadEffects();
    expect(live.rows.find((r) => r.id === id)).toMatchObject({ kind: 'publish_landing_status', deliveryState: 'AWAITING_REVIEW', lastError: 'boom' });
  });
});
