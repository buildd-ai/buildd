/**
 * The escalation dispatcher's once-per-verdict claim on real Postgres, and the give-back a
 * control-plane outage takes (lib/pr-landing-verdict-dispatch.ts `unclaim`): it deletes exactly
 * this verdict's dispatch row, so the next sweep can claim it again, and nothing else.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { defaultDispatchDeps, DISPATCH_SOURCE } = await import('../../src/lib/pr-landing-verdict-dispatch');

let teamId = '';
let workspaceId = '';
const record = async () => (await q<{ id: string }>(sql`INSERT INTO decision_records (team_id, workspace_id, capability, fingerprint, applied, status) VALUES (${teamId}::uuid, ${workspaceId}::uuid, 'escalation_gate', ${`fp-${crypto.randomUUID()}`}, true, 'applied') RETURNING id`))[0]!.id;
const rows = async (id: string) => (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM decision_outcomes WHERE decision_record_id = ${id}::uuid AND source = ${DISPATCH_SOURCE}`))[0]!.n;

beforeAll(async () => {
  assertDbConfigured();
  ({ teamId, workspaceId } = await seedWorkspace());
});

describe('the verdict dispatch claim', () => {
  test('claim once; unclaim deletes only this verdict\'s row, and the next sweep claims it again', async () => {
    const deps = defaultDispatchDeps();
    const [a, b] = [await record(), await record()];
    expect(await deps.claim(a, teamId)).toBe(true);
    expect(await deps.claim(a, teamId)).toBe(false);
    expect(await deps.claim(b, teamId)).toBe(true);
    await deps.unclaim!(a);
    expect(await rows(a)).toBe(0);
    expect(await rows(b)).toBe(1);
    expect(await deps.claim(a, teamId)).toBe(true);
  });
});
