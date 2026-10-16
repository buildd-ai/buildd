/**
 * AC-7 (docs/specs/workflow-kernel-library.md §2): the package's conformance
 * scenarios, unchanged, against buildd's Postgres store. The package runs the
 * same list on its in-memory store (packages/workflow-kernel/src/conformance/
 * conformance.test.ts); identical expectations on both is the proof that the
 * adapter keeps the kernel's CAS, uniqueness, outbox and lane rules.
 */
import { afterEach, beforeAll, describe, test } from 'bun:test';
import { db } from '@buildd/core/db';
import { sql } from 'drizzle-orm';
import { CONFORMANCE_SCENARIOS, type ConformanceHost } from '@buildd/workflow-kernel/conformance/scenarios';
import type { EffectKind } from '@buildd/workflow-kernel/commands';
import { postgresStore } from '../../src/lib/workflow/postgres-store';
import { builddPolicy } from '../../src/lib/workflow/kernel-policy';
import type { Exec } from '../../src/lib/workflow/kernel';
import { assertDbConfigured, q, seedTask, seedWorkspace } from './harness';

beforeAll(() => {
  assertDbConfigured();
});

const exec: Exec = (query) => db.execute(query) as unknown as Promise<{ rows?: unknown[] }>;
let repoSeq = 0;
/** Workspaces this file seeded: their outbox is settled after each scenario (below). */
const seeded: string[] = [];
const runTag = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function postgresHost(): ConformanceHost {
  return {
    store: postgresStore(exec),
    policy: builddPolicy(exec),
    newId: () => crypto.randomUUID(),
    // workflow_review_rounds.reviewer_task_id references tasks: a reviewer the fake Work files is a real row.
    newTaskId: (workspaceId) => seedTask(workspaceId, { status: 'pending' }),
    seedOwner: async () => {
      const { workspaceId } = await seedWorkspace();
      seeded.push(workspaceId);
      const ownerTaskId = await seedTask(workspaceId, { status: 'in_progress' });
      return { workspaceId, ownerTaskId };
    },
    // landing_lanes is keyed by (repo, base) across workspaces: each scenario gets its own repo.
    uniqueRepo: () => `acme/conformance-${runTag}-${++repoSeq}`,
    effects: async (deliveryId) => (await q<{ kind: string; payload: Record<string, unknown>; status: string; outcome: string | null; attempt_count: number; last_error: string | null; dedupe_key: string; transition_id: string }>(
      sql`SELECT kind, payload, status, outcome, attempt_count, last_error, dedupe_key, transition_id FROM workflow_effects WHERE delivery_id = ${deliveryId}::uuid ORDER BY created_at, id`,
    )).map((r) => ({
      kind: r.kind as EffectKind, payload: r.payload, status: r.status, outcome: r.outcome, attemptCount: Number(r.attempt_count), lastError: r.last_error,
      dedupeKey: r.dedupe_key, transitionId: String(r.transition_id),
    })),
    transitions: async (deliveryId) => (await q<{ from_version: number; to_version: number; command: string; to_state: string }>(
      sql`SELECT from_version, to_version, command, to_state FROM workflow_transitions WHERE delivery_id = ${deliveryId}::uuid ORDER BY to_version`,
    )).map((r) => ({ fromVersion: Number(r.from_version), toVersion: Number(r.to_version), command: r.command, toState: r.to_state })),
    setKernelEnabled: async (workspaceId, on) => {
      await q(sql`UPDATE workspaces SET git_config = jsonb_set(COALESCE(git_config, '{}'::jsonb), '{workflowKernel}', ${JSON.stringify(on)}::jsonb) WHERE id = ${workspaceId}::uuid`);
    },
  };
}

// The scenarios leave effects owed (most never drain). Other files drain the whole
// outbox with a batch limit, so settle ours rather than leave them due.
afterEach(async () => {
  if (!seeded.length) return;
  await q(sql`UPDATE workflow_effects SET status = 'done', outcome = 'conformance:settled', lease_until = NULL, updated_at = now()
    WHERE status IN ('pending', 'delivering')
      AND delivery_id IN (SELECT id FROM workflow_deliveries WHERE workspace_id IN (SELECT (jsonb_array_elements_text(${JSON.stringify(seeded)}::jsonb))::uuid))`);
});

describe('the kernel conformance scenarios on the Postgres store (AC-7)', () => {
  for (const sc of CONFORMANCE_SCENARIOS) {
    test(sc.name, async () => { await sc.run(postgresHost()); });
  }
});
