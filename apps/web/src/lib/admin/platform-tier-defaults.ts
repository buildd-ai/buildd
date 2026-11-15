/**
 * The one function behind every way a platform admin moves a tier for the
 * whole fleet: Settings › Models (operator section), `PUT /api/model-tiers/platform`
 * and the `manage_platform_tiers` MCP action all call `applyPlatformTierDefaultChange`,
 * and read through `readPlatformTierDefaults`. The admin check, the guard
 * rails (packages/core/model-tier-platform-default.ts) and the audit row live
 * here once, so the three surfaces cannot disagree.
 *
 * Who may write: a platform operator (lib/admin/platform-operator-caller.ts):
 * a signed-in operator, an OAuth bearer issued to one, or an admin-level
 * platform admin key. A team admin is refused, and so is a per-task token
 * however it was minted. Every write names `confirm: true`; a model outside
 * the tier's price band also needs `confirmBandChange: true`.
 *
 * Audit: one platform_admin_audit_events row per write, written as an intent
 * BEFORE the row changes and completed after, so no change can land without
 * its row. A write the store refuses (someone else changed the row first)
 * completes the intent as aborted and answers 409.
 *
 * Revert is one step: each stored row carries the snapshot it replaced, and
 * `revert` restores that (or clears the row when there was none).
 *
 * Handlers take their dependencies (`PlatformTierDefaultsDeps`) so this is
 * tested without a DB; platform-tier-defaults-deps.ts binds the real ones.
 */
import { TIER_PRICE_BANDS, type CatalogEntry } from '@buildd/core/model-catalog';
import type { CertificationMap } from '@buildd/core/model-certification';
import { TIERS, type Tier, type TierEntry } from '@buildd/core/model-tier-defaults';
import {
  checkPlatformTierModel,
  describeModelFacts,
  isPlatformTierVia,
  platformTierSuggestions,
  type ModelFacts,
  type PlatformTierActor,
  type PlatformTierDefault,
  type PlatformTierDefaultSnapshot,
  type PlatformTierRefusalCode,
  type PlatformTierSuggestion,
  type PlatformTierVia,
} from '@buildd/core/model-tier-platform-default';
import type { PlatformAdminAuditInput } from './audit';
import { OPERATOR_ONLY_ERROR } from './platform-operator-caller';

export interface PlatformTierCaller {
  user: { id: string; email?: string | null } | null;
  account: { id: string; level?: string | null; oauthUserId?: string | null } | null;
  /** A per-task token is refused for every write, whatever account minted it. */
  principal?: 'person' | 'key' | 'task_token';
}

export interface PlatformTierDefaultsDeps {
  now(): number;
  catalog(): Promise<readonly CatalogEntry[]>;
  certifications(): Promise<CertificationMap>;
  /** The platform-level answer for a tier (no team): the platform row, else the policy service, the catalog pick, the bundled fallback. */
  resolveEffective(tier: Tier): Promise<TierEntry>;
  readRow(tier: Tier): Promise<PlatformTierDefault | null>;
  /** Optimistic: true when the write landed while the row still held `prev`. */
  writeRow(tier: Tier, prev: PlatformTierDefault | null, next: PlatformTierDefault | null): Promise<boolean>;
  isOperator(caller: PlatformTierCaller): Promise<boolean>;
  auditIntent(event: Omit<PlatformAdminAuditInput, 'after'> & { after: Record<string, unknown> }): Promise<string>;
  auditComplete(id: string, after: Record<string, unknown>): Promise<boolean>;
}

// ── Read ────────────────────────────────────────────────────────────────────

export interface PlatformTierView {
  tier: Tier;
  band: { minInput: number; maxInput: number };
  /** What a team with no row of its own gets today, with the model's price, floor and certification. */
  effective: { provider: string; model: string; source: NonNullable<TierEntry['source']>; facts: ModelFacts };
  /** The stored platform default, or null when the tier follows the catalog and the bundled fallback. */
  platform: PlatformTierDefault | null;
  suggestion: PlatformTierSuggestion | null;
  /** A revert has something to do: a platform row exists. */
  canRevert: boolean;
}

export interface PlatformTierDefaultsView {
  tiers: PlatformTierView[];
  /** False when the catalog could not be read: no suggestion is a non-finding then. */
  catalogChecked: boolean;
  canWrite: boolean;
}

export async function readPlatformTierDefaults(caller: PlatformTierCaller, deps: PlatformTierDefaultsDeps): Promise<PlatformTierDefaultsView> {
  const now = deps.now();
  const [catalog, certifications, canWrite] = await Promise.all([
    deps.catalog().catch(() => [] as readonly CatalogEntry[]),
    deps.certifications().catch(() => new Map() as CertificationMap),
    deps.isOperator(caller),
  ]);
  const entries = await Promise.all(TIERS.map((tier) => deps.resolveEffective(tier)));
  const rows = await Promise.all(TIERS.map((tier) => deps.readRow(tier)));
  const effectiveByTier = Object.fromEntries(TIERS.map((tier, i) => [tier, { provider: entries[i].provider, model: entries[i].model }]));
  const suggestions = platformTierSuggestions(effectiveByTier, catalog, certifications, now);
  return {
    tiers: TIERS.map((tier, i) => ({
      tier,
      band: TIER_PRICE_BANDS[tier],
      effective: {
        provider: entries[i].provider,
        model: entries[i].model,
        source: entries[i].source ?? 'default',
        facts: describeModelFacts(entries[i].model, catalog, certifications, now),
      },
      platform: rows[i],
      suggestion: suggestions.find((s) => s.tier === tier) ?? null,
      canRevert: rows[i] !== null,
    })),
    catalogChecked: catalog.length > 0,
    canWrite,
  };
}

// ── Write ───────────────────────────────────────────────────────────────────

export const PLATFORM_TIER_CHANGE_OPS = ['set', 'apply', 'clear', 'revert'] as const;
export type PlatformTierChangeOp = (typeof PLATFORM_TIER_CHANGE_OPS)[number];

export interface PlatformTierChange {
  op: PlatformTierChangeOp;
  tier: Tier;
  /** set only. */
  model?: string;
  reason?: string | null;
  confirm: boolean;
  confirmBandChange: boolean;
  via: PlatformTierVia;
}

export type PlatformTierChangeCode =
  | PlatformTierRefusalCode
  | 'bad_request'
  | 'operator_only'
  | 'no_change'
  | 'nothing_to_revert'
  | 'no_suggestion'
  | 'conflict'
  | 'audit_failed';

export type PlatformTierChangeResult =
  | {
      ok: true;
      op: PlatformTierChangeOp;
      tier: Tier;
      before: PlatformTierDefaultSnapshot | null;
      after: PlatformTierDefaultSnapshot | null;
      /** What the tier resolves to now, at platform level. */
      effective: { provider: string; model: string; source: NonNullable<TierEntry['source']> };
      facts: ModelFacts | null;
    }
  | { ok: false; status: number; code: PlatformTierChangeCode; error: string; detail?: Record<string, unknown> };

const REASON_MAX = 500;

/** A request body as a change, or a 400. `via` defaults to `api`; the UI and MCP name themselves. */
export function parsePlatformTierChange(body: unknown): { ok: true; change: PlatformTierChange } | { ok: false; status: 400; code: 'bad_request'; error: string } {
  const bad = (error: string) => ({ ok: false as const, status: 400 as const, code: 'bad_request' as const, error });
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('body must be an object');
  const b = body as Record<string, unknown>;
  if (!(PLATFORM_TIER_CHANGE_OPS as readonly unknown[]).includes(b.op)) return bad(`op must be one of ${PLATFORM_TIER_CHANGE_OPS.join(', ')}`);
  if (!TIERS.includes(b.tier as Tier)) return bad(`tier must be one of ${TIERS.join(', ')}`);
  if (b.op === 'set' && (typeof b.model !== 'string' || !b.model.trim())) return bad('model is required for set');
  if (b.reason != null && typeof b.reason !== 'string') return bad('reason must be a string');
  if (b.via != null && !isPlatformTierVia(b.via)) return bad('via must be ui, mcp or api');
  return {
    ok: true,
    change: {
      op: b.op as PlatformTierChangeOp,
      tier: b.tier as Tier,
      ...(typeof b.model === 'string' ? { model: b.model.trim() } : {}),
      reason: typeof b.reason === 'string' && b.reason.trim() ? b.reason.trim().slice(0, REASON_MAX) : null,
      confirm: b.confirm === true,
      confirmBandChange: b.confirmBandChange === true,
      via: isPlatformTierVia(b.via) ? b.via : 'api',
    },
  };
}

const snapshot = (row: PlatformTierDefault | PlatformTierDefaultSnapshot | null): PlatformTierDefaultSnapshot | null => {
  if (!row) return null;
  const { tier, provider, model, setAt, setBy, reason } = row;
  return { tier, provider, model, setAt, setBy, reason };
};

export async function applyPlatformTierDefaultChange(
  caller: PlatformTierCaller,
  change: PlatformTierChange,
  deps: PlatformTierDefaultsDeps,
): Promise<PlatformTierChangeResult> {
  const fail = (status: number, code: PlatformTierChangeCode, error: string, detail?: Record<string, unknown>): PlatformTierChangeResult =>
    ({ ok: false, status, code, error, ...(detail ? { detail } : {}) });

  // The admin check: a platform operator, never a team role, never a per-task token.
  if (caller.principal === 'task_token' || !(await deps.isOperator(caller))) {
    return fail(403, 'operator_only', `${OPERATOR_ONLY_ERROR} Only a platform admin changes the default model of a tier for every team.`);
  }
  if (!TIERS.includes(change.tier)) return fail(400, 'unknown_tier', `tier must be one of ${TIERS.join(', ')}`);

  const now = deps.now();
  const actor: PlatformTierActor = { accountId: caller.account?.id ?? null, userId: caller.user?.id ?? caller.account?.oauthUserId ?? null, via: change.via };
  const prev = await deps.readRow(change.tier);

  let next: PlatformTierDefault | null;
  let facts: ModelFacts | null = null;
  let model = change.model ?? null;

  if (change.op === 'apply') {
    // Apply the suggestion the admin surfaces show: the liveness audit's newer model, nothing else.
    const [catalog, certifications, effective] = await Promise.all([deps.catalog(), deps.certifications(), deps.resolveEffective(change.tier)]);
    const s = platformTierSuggestions({ [change.tier]: { provider: effective.provider, model: effective.model } }, catalog, certifications, now)
      .find((x) => x.tier === change.tier && x.kind === 'newer');
    if (!s?.newer) return fail(409, 'no_suggestion', `No newer model is suggested for ${change.tier}; nothing to apply.`);
    model = s.newer;
  }

  if (change.op === 'set' || change.op === 'apply') {
    const [catalog, certifications] = await Promise.all([deps.catalog(), deps.certifications()]);
    const check = checkPlatformTierModel({
      tier: change.tier, model: model ?? '', catalog, certifications, now,
      confirm: change.confirm, confirmBandChange: change.confirmBandChange,
    });
    if (!check.ok) return fail(check.refusal.status, check.refusal.code, check.refusal.error, check.refusal.detail);
    facts = check.facts;
    if (prev && prev.model === model) return fail(409, 'no_change', `${model} is already the platform default for ${change.tier}.`);
    next = {
      tier: change.tier, provider: 'anthropic', model: model!, setAt: new Date(now).toISOString(), setBy: actor,
      reason: change.reason ?? (change.op === 'apply' ? 'apply suggestion' : null), previous: snapshot(prev),
    };
  } else {
    if (!change.confirm) {
      return fail(409, 'confirm_required', `This ${change.op === 'clear' ? 'removes' : 'reverts'} the platform default for ${change.tier} for every team without its own row; pass confirm: true to apply it.`);
    }
    if (!prev) return fail(409, change.op === 'clear' ? 'no_change' : 'nothing_to_revert', `${change.tier} has no platform default; it already follows the catalog and the bundled fallback.`);
    if (change.op === 'clear') {
      next = null;
    } else {
      // Revert restores what the last write replaced; when that was nothing, the row goes.
      next = prev.previous
        ? { ...prev.previous, setAt: new Date(now).toISOString(), setBy: actor, reason: change.reason ?? `revert of the change made ${prev.setAt}`, previous: snapshot(prev) }
        : null;
    }
  }

  // Intent first: nothing changes without its audit row.
  let auditId: string;
  const after = { op: change.op, via: change.via, reason: change.reason ?? null, actor: { accountId: actor.accountId, userId: actor.userId }, model: next?.model ?? null };
  try {
    auditId = await deps.auditIntent({
      actorAccountId: actor.accountId,
      action: `platform_tier_default.${change.op}`,
      targetType: 'platform_tier_default',
      targetId: change.tier,
      teamId: null,
      before: (snapshot(prev) ?? {}) as Record<string, unknown>,
      after,
    });
  } catch (err) {
    console.error('[platform-tier-defaults] audit intent failed; nothing written:', err instanceof Error ? err.message : err);
    return fail(500, 'audit_failed', 'The audit row could not be written, so nothing was changed. Retry.');
  }

  const landed = await deps.writeRow(change.tier, prev, next);
  if (!landed) {
    await deps.auditComplete(auditId, { ...after, phase: 'aborted', abortReason: 'conflict' }).catch(() => false);
    return fail(409, 'conflict', `The platform default for ${change.tier} changed under you; read it again and retry.`);
  }
  await deps.auditComplete(auditId, { ...after, ...(snapshot(next) ?? { cleared: true }) }).catch((err) => {
    console.error('[platform-tier-defaults] write landed but its audit row could not be completed:', err instanceof Error ? err.message : err);
    return false;
  });
  console.log(`[platform-tier-defaults] ${change.op} ${change.tier}: ${prev?.model ?? '(none)'} -> ${next?.model ?? '(none)'} via ${change.via}`);

  const effective = await deps.resolveEffective(change.tier);
  return {
    ok: true,
    op: change.op,
    tier: change.tier,
    before: snapshot(prev),
    after: snapshot(next),
    effective: { provider: effective.provider, model: effective.model, source: effective.source ?? 'default' },
    facts,
  };
}
