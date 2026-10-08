/**
 * `kernelOwnedDeliveryStates` against real Postgres: the live sibling conflict
 * probe skips a worker whose PR the workflow kernel is driving, and the read
 * behind that skip is hand-built SQL a mocked `db` cannot run.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { kernelOwnedDeliveryStates } from '../../src/lib/workflow/delivery-view';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

let t: { repairing: string; released: string; none: string };
beforeAll(async () => {
  assertDbConfigured();
  const { workspaceId } = await seedWorkspace({});
  const [repairing, released, none] = await Promise.all([seedTask(workspaceId), seedTask(workspaceId), seedTask(workspaceId)]);
  await q(sql`INSERT INTO workflow_deliveries (workspace_id, owner_task_id, state, authority) VALUES
    (${workspaceId}::uuid, ${repairing}::uuid, 'REPAIRING', 'kernel'),
    (${workspaceId}::uuid, ${released}::uuid, 'AWAITING_REVIEW', 'legacy')`);
  t = { repairing, released, none };
}, 30_000);

describe('kernelOwnedDeliveryStates', () => {
  test('returns the state of kernel-authority deliveries only, keyed by owner task', async () => {
    const rows = await kernelOwnedDeliveryStates([t.repairing, t.released, t.none]);
    expect(rows).toEqual([{ ownerTaskId: t.repairing, state: 'REPAIRING' }]);
  });

  test('an empty list issues no query and returns nothing', async () => {
    expect(await kernelOwnedDeliveryStates([])).toEqual([]);
  });
});
