/**
 * Request-time model-tier ceiling check, shared by every route that accepts
 * an explicit tier or model: task create / update, a chat's new session and
 * pin, and a chat turn. Docs: docs/specs/model-tier-ceilings.md.
 *
 * This is the early, actionable refusal — the caller learns at the moment of
 * asking, with a 403 `policy_denied` body naming the maximum, who set it and
 * what to do. It is not the only check: the claim route re-checks every task
 * on every claim (a ceiling lowered after create still holds it, and the
 * ~30 insert paths that bypass POST /api/tasks are covered there), and the
 * chat turn re-checks every turn.
 */
import { NextResponse } from 'next/server';
import { getCachedOpenRouterCatalog } from '@buildd/core/model-catalog-cache';
import { enforceModelCeiling } from '@buildd/core/model-tier-ceiling';
import { loadTierCeiling, type CeilingSubject } from '@buildd/core/model-tier-ceiling-store';
import { shorthandPinTier } from '@buildd/core/model-pin';
import { GATE_SLUGS, type GateCallerOrigin } from '@buildd/core/gate-events';
import type { CatalogEntry } from '@buildd/core/model-catalog';
import {
  enforceTierCeiling,
  isCeilingTier,
  type CeilingSurface,
  type CeilingTier,
  type PolicyDeniedError,
  type TierCeiling,
  type TierRequestOrigin,
} from '@buildd/shared';
import { fireGateEvent } from './gate-ledger';

export interface TierRequest {
  /** An explicit tier (tasks.tier, a chat pin, a plan request's tier). */
  tier?: unknown;
  tierOrigin?: TierRequestOrigin;
  /** A caller model pin: a shorthand (`opus`) or an exact id. */
  model?: unknown;
  /**
   * The stated role's model, already split by the caller (role-model-routing:
   * `roleFloorTier` / `isExactRoleModel`): its tier floor, or its exact id.
   */
  roleTier?: CeilingTier | null;
  roleExactModel?: string | null;
}

/** The first explicit part of `req` the ceiling refuses, or null. Pure. */
export function deniedByCeiling(ceiling: TierCeiling, req: TierRequest, catalog: readonly CatalogEntry[]): PolicyDeniedError | null {
  if (!ceiling.max) return null;
  if (isCeilingTier(req.tier)) {
    const v = enforceTierCeiling({ ceiling, tier: req.tier, origin: req.tierOrigin ?? 'task_tier' });
    if (!v.ok) return v.denied;
  }
  if (typeof req.model === 'string' && req.model.trim()) {
    const pin = req.model.trim();
    const pinTier = shorthandPinTier(pin);
    const v = pinTier
      ? enforceTierCeiling({ ceiling, tier: pinTier, origin: 'model_pin' })
      : enforceModelCeiling({ ceiling, model: pin, origin: 'model_pin', catalog });
    if (!v.ok) return v.denied;
  }
  if (req.roleTier) {
    const v = enforceTierCeiling({ ceiling, tier: req.roleTier, origin: 'role_model' });
    if (!v.ok) return v.denied;
  }
  if (req.roleExactModel) {
    const v = enforceModelCeiling({ ceiling, model: req.roleExactModel, origin: 'role_model', catalog });
    if (!v.ok) return v.denied;
  }
  return null;
}

export interface CeilingCheckDeps {
  load: (subject: CeilingSubject, surface: CeilingSurface) => Promise<TierCeiling>;
  catalog: () => Promise<readonly CatalogEntry[]>;
}

const defaultDeps: CeilingCheckDeps = {
  load: (subject, surface) => loadTierCeiling(subject, surface),
  catalog: () => getCachedOpenRouterCatalog().catch(() => []),
};

/** The ceiling for a request, through the same seam the check uses. */
export function loadRequestCeiling(subject: CeilingSubject, surface: CeilingSurface, deps: CeilingCheckDeps = defaultDeps): Promise<TierCeiling> {
  return deps.load(subject, surface);
}

/**
 * A routing preview with the ceiling applied: an automatic tier above it is
 * shown at the ceiling, as the claim will serve it (explicit requests above it
 * were already refused). Same rule as the claim route, so the preview never
 * promises a tier the claim will not run.
 */
export function previewUnderCeiling<P extends { tier: CeilingTier | null; model: string; reason: string }>(
  preview: P,
  ceiling: TierCeiling,
  modelFor: (tier: CeilingTier) => string,
): P {
  if (!ceiling.max || !preview.tier || !ceiling.binding) return preview;
  const v = enforceTierCeiling({ ceiling, tier: preview.tier, origin: 'auto' });
  if (!v.ok) return { ...preview, reason: `${preview.reason}; ${v.denied.message} It will be held at claim. ${v.denied.remedy}` };
  if (!v.downgradedFrom) return preview;
  return { ...preview, tier: v.tier, model: modelFor(v.tier), reason: `${preview.reason}; capped at ${v.tier} by the ${ceiling.binding.source.replace('_', ' ')} tier maximum` };
}

/**
 * Load the ceiling for `subject` and check `req` against it. Returns the
 * 403 response to send, or null to carry on. A request with nothing explicit
 * in it never reads the DB.
 */
export async function rejectOverCeiling(args: {
  subject: CeilingSubject;
  surface: CeilingSurface;
  request: TierRequest;
  gate: { surface: string; workspaceId?: string | null; taskId?: string | null; callerOrigin?: GateCallerOrigin | null };
  deps?: CeilingCheckDeps;
  /** Already loaded by the caller (it also needed it for a preview). */
  ceiling?: TierCeiling;
}): Promise<NextResponse | null> {
  const r = args.request;
  const hasExplicit = isCeilingTier(r.tier) || (typeof r.model === 'string' && !!r.model.trim()) || !!r.roleTier || !!r.roleExactModel;
  if (!hasExplicit) return null;
  const deps = args.deps ?? defaultDeps;
  const ceiling = args.ceiling ?? await deps.load(args.subject, args.surface);
  if (!ceiling.max) return null;
  // Only a concrete model id needs pricing; a tier request never fetches the catalog.
  const needsCatalog = (typeof r.model === 'string' && !!r.model.trim()) || !!r.roleExactModel;
  const denied = deniedByCeiling(ceiling, r, needsCatalog ? await deps.catalog() : []);
  if (!denied) return null;
  fireGateEvent({
    gate: GATE_SLUGS.TIER_CEILING,
    surface: args.gate.surface,
    outcome: 'rejected',
    reason: denied.message,
    workspaceId: args.gate.workspaceId ?? null,
    taskId: args.gate.taskId ?? null,
    callerOrigin: args.gate.callerOrigin ?? 'api',
    detail: { ...denied },
  });
  return NextResponse.json(denied, { status: 403 });
}
