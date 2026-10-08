/**
 * §10.3: what happens when a workflow effect goes `dead` (8 failed tries).
 *
 * Every dead effect writes a `workflow_effect_dead` gate event. A critical one
 * (effects.ts `CRITICAL_EFFECTS`) also applies `EffectDead` through the
 * reducer, which moves the delivery to ESCALATED while it is still in the state
 * that owed the effect: a dead `merge_call` or `verify_merge` would otherwise
 * hold LANDING forever (every door answers `landing_in_flight`), and a dead
 * dispatch or `push_recovery` is a key the floor never re-owes.
 *
 * Runs from `runEffects`, so every drain (inline, cron, tests) escalates.
 */
import { sql } from 'drizzle-orm';
import { GATE_SLUGS, recordGateEvent } from '@buildd/core/gate-events';
import type { DeadEffect } from './effects';
import { applyCommand, type Exec } from './kernel';

export async function escalateDeadEffect(dead: DeadEffect, exec: Exec): Promise<{ applied: boolean; result: string }> {
  let applied = false;
  let result = 'not_critical';
  if (dead.critical) {
    const res = await applyCommand(
      { type: 'EffectDead', actor: 'kernel:effects', effectId: dead.id, effectKind: dead.kind, dedupeKey: dead.dedupeKey, lastError: dead.lastError },
      { ref: { deliveryId: dead.deliveryId }, exec },
    );
    applied = res.result === 'applied';
    result = res.result === 'applied' ? 'applied' : `${res.result}:${res.reason}`;
  }
  const owner = ((await exec(sql`-- workflow:dead_effect_owner
SELECT workspace_id, owner_task_id FROM workflow_deliveries WHERE id = ${dead.deliveryId}::uuid`)).rows ?? [])[0] as
    { workspace_id?: string; owner_task_id?: string } | undefined;
  await recordGateEvent({
    gate: GATE_SLUGS.WORKFLOW_EFFECT_DEAD,
    surface: 'workflow:effects',
    outcome: dead.critical ? 'stranded' : 'warned',
    reason: `${dead.kind} effect dead: ${dead.lastError}`,
    workspaceId: owner?.workspace_id ?? null,
    taskId: owner?.owner_task_id ?? null,
    detail: { kind: dead.kind, deliveryId: dead.deliveryId, effectId: dead.id, dedupeKey: dead.dedupeKey, critical: dead.critical, applied, result },
    callerOrigin: 'system',
  });
  return { applied, result };
}
