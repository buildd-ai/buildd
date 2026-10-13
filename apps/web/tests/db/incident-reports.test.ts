/**
 * incident_reports idempotency against real Postgres (bug-intake-and-quality
 * AC-3): the unique (workspace_id, idempotency_key) index plus ON CONFLICT DO
 * NOTHING makes concurrent identical reports converge on one row.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { sql } from 'drizzle-orm';
import { assertDbConfigured, q, seedWorkspace } from './harness';

const { intakeReport } = await import('../../src/lib/incident-intake');

let wsA: string;
let wsB: string;
const key = () => `agent_friction:${Math.random().toString(36).slice(2, 10)}`;
const count = async (ws: string, k: string) =>
  (await q<{ n: number }>(sql`SELECT count(*)::int AS n FROM incident_reports WHERE workspace_id = ${ws}::uuid AND idempotency_key = ${k}`))[0].n;

beforeAll(async () => {
  assertDbConfigured();
  ({ workspaceId: wsA } = await seedWorkspace());
  ({ workspaceId: wsB } = await seedWorkspace());
});

describe('incident_reports idempotency', () => {
  test('a repeat call returns the existing row and creates no second one', async () => {
    const k = key();
    const input = { workspaceId: wsA, source: 'agent_friction' as const, idempotencyKey: k, title: 't', excerpt: 'Error: boom' };
    const first = await intakeReport(input);
    const second = await intakeReport({ ...input, title: 'other' });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.report!.id).toBe(first.report!.id);
    expect(await count(wsA, k)).toBe(1);
  });

  test('concurrent identical calls produce exactly one row', async () => {
    const k = key();
    const input = { workspaceId: wsA, source: 'ci' as const, idempotencyKey: k, title: 't' };
    const results = await Promise.all(Array.from({ length: 8 }, () => intakeReport(input)));
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(new Set(results.map((r) => r.report!.id)).size).toBe(1);
    expect(await count(wsA, k)).toBe(1);
  });

  test('the same key in another workspace is a separate report', async () => {
    const k = key();
    await intakeReport({ workspaceId: wsA, source: 'owner', idempotencyKey: k, title: 't' });
    const b = await intakeReport({ workspaceId: wsB, source: 'owner', idempotencyKey: k, title: 't' });
    expect(b.created).toBe(true);
  });

  test('the database itself refuses a duplicate (workspace, key)', async () => {
    const k = key();
    await intakeReport({ workspaceId: wsA, source: 'owner', idempotencyKey: k, title: 't' });
    let err: unknown;
    try {
      await q(sql`INSERT INTO incident_reports (workspace_id, source, title, idempotency_key) VALUES (${wsA}::uuid, 'owner', 't', ${k})`);
    } catch (e) { err = e; }
    expect(String((err as Error)?.message ?? err)).toMatch(/unique|duplicate|incident_reports/i);
  });
});
