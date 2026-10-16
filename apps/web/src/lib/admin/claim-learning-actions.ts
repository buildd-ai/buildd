import type { PlatformAdminAuditInput } from './audit';

export const CLAIM_LEARNING_ACTIONS = ['claim_learning_pin', 'claim_learning_revert', 'claim_learning_set_delta'] as const;
export type ClaimLearningCapability = typeof CLAIM_LEARNING_ACTIONS[number];
export interface ClaimLearningChange {
  capability: ClaimLearningCapability;
  gate: string;
  area: string;
  expectedRevision: number;
  reason: string;
  fraction?: number;
  delta?: number;
  actorAccountId: string;
}
export interface ClaimLearningActionDeps {
  change(input: ClaimLearningChange): Promise<Record<string, unknown>>;
  auditIntent(event: PlatformAdminAuditInput): Promise<string>;
  auditComplete(id: string, after: Record<string, unknown>): Promise<boolean>;
}

/** Owner gate belongs to the route. Audit intent must land before touching policy. */
export async function handleClaimLearningAction(
  deps: ClaimLearningActionDeps,
  owner: { accountId: string; operatorLabel: string | null },
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const bad = () => ({ status: 400, body: { error: 'Invalid claim learning action: capability, gate, area, expectedRevision and reason are required' } });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad();
  const b = body as Record<string, unknown>;
  if (!(CLAIM_LEARNING_ACTIONS as readonly unknown[]).includes(b.capability)
    || typeof b.gate !== 'string' || !/^[a-zA-Z0-9_.-]{1,100}$/.test(b.gate)
    || typeof b.area !== 'string' || !/^[a-zA-Z0-9_./-]{1,100}$/.test(b.area)
    || !Number.isSafeInteger(b.expectedRevision) || (b.expectedRevision as number) < 0
    || typeof b.reason !== 'string' || !b.reason.trim() || b.reason.length > 2000) return bad();
  const capability = b.capability as ClaimLearningCapability;
  const unit = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;
  if (capability === 'claim_learning_pin' && !unit(b.fraction)) return bad();
  if (capability === 'claim_learning_set_delta' && !unit(b.delta)) return bad();
  const allowed = new Set(['capability', 'gate', 'area', 'expectedRevision', 'reason', ...(capability === 'claim_learning_pin' ? ['fraction'] : capability === 'claim_learning_set_delta' ? ['delta'] : [])]);
  if (Object.keys(b).some(key => !allowed.has(key))) return bad();
  const input: ClaimLearningChange = {
    capability, gate: b.gate, area: b.area, expectedRevision: b.expectedRevision as number,
    reason: b.reason.trim(), actorAccountId: owner.accountId,
    ...(capability === 'claim_learning_pin' ? { fraction: b.fraction as number } : {}),
    ...(capability === 'claim_learning_set_delta' ? { delta: b.delta as number } : {}),
  };
  try {
    const auditId = await deps.auditIntent({
      actorAccountId: owner.accountId, action: `claim_learning.${capability}`,
      targetType: 'automation', targetId: `claim-learning:${input.gate}:${input.area}`, teamId: null,
      before: { expectedRevision: input.expectedRevision },
      after: { operatorLabel: owner.operatorLabel, reason: input.reason, request: input },
    });
    let outcome: Record<string, unknown>;
    try { outcome = await deps.change(input); }
    catch (error) {
      await deps.auditComplete(auditId, { phase: 'failed', error: error instanceof Error ? error.message : 'Policy change failed' });
      throw error;
    }
    if (!(await deps.auditComplete(auditId, { phase: 'completed', operatorLabel: owner.operatorLabel, reason: input.reason, request: input, outcome }))) {
      return { status: 500, body: { error: 'Policy audit completion failed' } };
    }
    return { status: outcome.status === 'stale' ? 409 : outcome.status === 'rejected' ? 422 : 200, body: outcome };
  } catch {
    return { status: 500, body: { error: 'Policy change could not be confirmed' } };
  }
}
