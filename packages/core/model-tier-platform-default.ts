/**
 * Platform tier default: the model a tier runs for every team that has no
 * registry row of its own, chosen by a platform admin and changeable without
 * a deploy.
 *
 * Where it sits in resolution (model-tier-registry.ts): after the team's
 * registry (a team's or workspace's row always wins) and before the policy
 * service, the catalog pick and the bundled fallback. So a platform admin can
 * move a tier (premium-plus from one Fable release to the next) for the whole
 * fleet with one write, and a team that wants something else still pins its
 * own row.
 *
 * Storage is one `system_cache` row per tier (model-tier-platform-default-store.ts),
 * like the other platform runtime records (the rerank switch, model
 * certifications). No new table, no migration: the record is small, re-derivable
 * from the audit trail, and read on the claim path through the same 60s cache
 * the registry uses.
 *
 * Guard rails, not trust (`checkPlatformTierModel`): a model is refused when
 * the live catalog cannot be read or does not list it, when nothing has
 * certified a CLI floor for it (the static table or the certification probe;
 * nobody guesses), when it is retired, and when it sits outside the tier's
 * price band unless the caller confirms the spend change. Every write also
 * needs an explicit confirm. The caller (apps/web/src/lib/admin/platform-tier-defaults.ts)
 * holds the admin check and writes the audit row; this module is pure.
 *
 * Staleness is surfaced, never acted on (`platformTierSuggestions`): the
 * liveness audit (model-tier-liveness.ts) compares each effective model with
 * the catalog and the result is shown with an Apply control. Which model backs
 * a tier is a policy call and a person makes it.
 */
import { TIERS, type Tier, type TierProvider } from './model-tier-defaults';
import { TIER_PRICE_BANDS, modelVariantFlags, snapshotBase, type CatalogEntry } from './model-catalog';
import { MODEL_MIN_CLI_VERSION } from './model-capability-requirements';
import { certifiedFloor, findCertification, type CertificationMap, type ModelDeprecation } from './model-certification';
import { describeCertification, type CertificationView } from './model-certification-candidates';
import { auditTierModels } from './model-tier-liveness';

export const PLATFORM_TIER_DEFAULT_KEY_PREFIX = 'platform_tier_default:';

export function platformTierDefaultKey(tier: Tier): string {
  return PLATFORM_TIER_DEFAULT_KEY_PREFIX + tier;
}

/** How the change arrived. An audit label, not an authorization input. */
export type PlatformTierVia = 'ui' | 'mcp' | 'api';
export const PLATFORM_TIER_VIAS: readonly PlatformTierVia[] = ['ui', 'mcp', 'api'];

export function isPlatformTierVia(v: unknown): v is PlatformTierVia {
  return typeof v === 'string' && (PLATFORM_TIER_VIAS as readonly string[]).includes(v);
}

export interface PlatformTierActor {
  /** The API account behind the call (a platform admin key, or the team account of an OAuth session). */
  accountId: string | null;
  /** The signed-in person, when there is one. */
  userId: string | null;
  via: PlatformTierVia;
}

/** One tier's platform default as stored, without its revert pointer. */
export interface PlatformTierDefaultSnapshot {
  tier: Tier;
  /** Anthropic only: the bundled fallback and the catalog pick are Anthropic-only too, so no team is routed to a provider it has not configured. */
  provider: Extract<TierProvider, 'anthropic'>;
  model: string;
  /** ISO time of the write. */
  setAt: string;
  setBy: PlatformTierActor;
  reason: string | null;
}

export interface PlatformTierDefault extends PlatformTierDefaultSnapshot {
  /** What this write replaced, so a revert is one step. Null: there was no row. */
  previous: PlatformTierDefaultSnapshot | null;
}

const MODEL_ID_RE = /^claude-[a-z0-9-]{1,80}$/;

function parseActor(raw: unknown): PlatformTierActor | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isPlatformTierVia(r.via)) return null;
  return {
    accountId: typeof r.accountId === 'string' ? r.accountId : null,
    userId: typeof r.userId === 'string' ? r.userId : null,
    via: r.via,
  };
}

function parseSnapshot(raw: unknown): PlatformTierDefaultSnapshot | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!TIERS.includes(r.tier as Tier)) return null;
  if (r.provider !== 'anthropic') return null;
  if (typeof r.model !== 'string' || !MODEL_ID_RE.test(r.model)) return null;
  if (typeof r.setAt !== 'string') return null;
  const setBy = parseActor(r.setBy);
  if (!setBy) return null;
  return {
    tier: r.tier as Tier,
    provider: 'anthropic',
    model: r.model,
    setAt: r.setAt,
    setBy,
    reason: typeof r.reason === 'string' ? r.reason : null,
  };
}

/** A stored value as a record, or null when absent or malformed (read as "no platform default"). */
export function parsePlatformTierDefault(raw: unknown): PlatformTierDefault | null {
  const snap = parseSnapshot(raw);
  if (!snap) return null;
  const prev = (raw as Record<string, unknown>).previous;
  return { ...snap, previous: prev == null ? null : parseSnapshot(prev) };
}

// ── Facts about a model, for the guard rails and the admin surfaces ─────────

export interface ModelFacts {
  model: string;
  /** The catalog entry this id names (by id, canonical id or dated snapshot), or null. */
  catalogId: string | null;
  inCatalog: boolean;
  /** USD per MTok, from the live catalog. Null when the catalog does not list it. */
  price: { input: number; output: number } | null;
  /** The CLI version a runner must report: the static table's row, else the probe's. Null when none is recorded. */
  floor: string | null;
  certification: CertificationView['state'];
  /** baseline (the static table vouches for it) or probe-certified. */
  certified: boolean;
  releasedAt: string | null;
  deprecated: ModelDeprecation | null;
  retired: boolean;
}

function recordedFloor(id: string | null | undefined): string | null {
  return id && Object.hasOwn(MODEL_MIN_CLI_VERSION, id) ? MODEL_MIN_CLI_VERSION[id] : null;
}

function findEntry(catalog: readonly CatalogEntry[], model: string): CatalogEntry | null {
  const bare = snapshotBase(model);
  return (
    catalog.find((e) => e.id === model) ??
    catalog.find((e) => e.canonicalId === model) ??
    catalog.find((e) => e.id === bare) ??
    null
  );
}

export function describeModelFacts(
  model: string,
  catalog: readonly CatalogEntry[],
  certifications: CertificationMap,
  now: number,
): ModelFacts {
  const entry = findEntry(catalog, model);
  const id = entry?.id ?? model;
  const view = describeCertification(id, catalog, certifications, now);
  const cert = findCertification(certifications, id) ?? (entry?.canonicalId ? findCertification(certifications, entry.canonicalId) : null);
  const floor =
    recordedFloor(id) ?? recordedFloor(entry?.canonicalId) ?? recordedFloor(snapshotBase(model)) ?? (cert ? certifiedFloor(cert) : null);
  return {
    model,
    catalogId: entry?.id ?? null,
    inCatalog: entry !== null,
    price: entry ? { input: entry.input, output: entry.output } : null,
    floor,
    certification: view.state,
    certified: view.state === 'baseline' || view.state === 'certified',
    releasedAt: view.releasedAt,
    deprecated: view.deprecated,
    retired: view.retired,
  };
}

// ── Guard rails ─────────────────────────────────────────────────────────────

export type PlatformTierRefusalCode =
  | 'unknown_tier'
  | 'invalid_model'
  | 'catalog_unavailable'
  | 'model_not_in_catalog'
  | 'retired'
  | 'not_certified'
  | 'spend_band_change'
  | 'confirm_required';

export interface PlatformTierRefusal {
  code: PlatformTierRefusalCode;
  /** The HTTP status the route answers with. */
  status: number;
  error: string;
  detail?: Record<string, unknown>;
}

export type PlatformTierModelCheck =
  | { ok: true; facts: ModelFacts; bandChange: 'below' | 'above' | null }
  | { ok: false; refusal: PlatformTierRefusal };

export interface PlatformTierModelCheckInput {
  tier: Tier;
  model: string;
  catalog: readonly CatalogEntry[];
  certifications: CertificationMap;
  now: number;
  /** The caller confirmed the write. Required for every change. */
  confirm: boolean;
  /** The caller accepts a model outside the tier's price band. */
  confirmBandChange: boolean;
}

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/**
 * May `model` become `tier`'s platform default? Refusals come in the order a
 * caller can act on them: the model's own problems first, the band change,
 * then the missing confirm, so one call says what is really wrong.
 */
export function checkPlatformTierModel(input: PlatformTierModelCheckInput): PlatformTierModelCheck {
  const { tier, model } = input;
  const refuse = (code: PlatformTierRefusalCode, status: number, error: string, detail?: Record<string, unknown>): PlatformTierModelCheck =>
    ({ ok: false, refusal: { code, status, error, ...(detail ? { detail } : {}) } });

  if (!TIERS.includes(tier)) return refuse('unknown_tier', 400, `tier must be one of ${TIERS.join(', ')}`);
  if (typeof model !== 'string' || !MODEL_ID_RE.test(model)) {
    return refuse('invalid_model', 400, 'model must be a full Anthropic model id (claude-…); the platform default is Anthropic-only');
  }
  if (input.catalog.length === 0) {
    return refuse('catalog_unavailable', 503, 'the live model catalog could not be read, so the model cannot be verified; try again shortly');
  }
  const facts = describeModelFacts(model, input.catalog, input.certifications, input.now);
  if (!facts.inCatalog) {
    return refuse('model_not_in_catalog', 422, `${model} is not in the live model catalog (retired, renamed, or a typo); a tier is never pointed at a model nobody can call`);
  }
  if (facts.retired) {
    return refuse('retired', 422, `${model} is retired${facts.deprecated?.retiresAt ? ` (since ${facts.deprecated.retiresAt.slice(0, 10)})` : ''}; pick a live model`, { retiresAt: facts.deprecated?.retiresAt ?? null });
  }
  if (!facts.certified) {
    const state = facts.certification;
    const next =
      state === 'discovered' ? 'the certification probe runs on the next runner heartbeat that can serve it'
      : state === 'probing' ? 'a probe is in flight'
      : state === 'failed' ? 'the last probe failed and will retry after its backoff'
      : state === 'incompatible' ? `the provider named a floor (${facts.floor ?? 'unknown'}) no probing runner has met yet`
      : 'no probe has certified it';
    return refuse(
      'not_certified',
      422,
      `${model} has no certified CLI floor yet (${state}): ${next}. ` +
        `Check it with manage_model_tiers action=model model=${model}; a platform admin can certify it by hand through the model-certifications admin route. The floor is never guessed.`,
      { certification: state, floor: facts.floor },
    );
  }
  const band = TIER_PRICE_BANDS[tier];
  const price = facts.price!.input;
  const bandChange: 'below' | 'above' | null = price < band.minInput ? 'below' : price >= band.maxInput ? 'above' : null;
  if (bandChange && !input.confirmBandChange) {
    return refuse(
      'spend_band_change',
      409,
      `${model} is priced at ${money(price)} input per MTok, ${bandChange} the ${tier} band (${money(band.minInput)} to ${money(band.maxInput)}). ` +
        `This ${bandChange === 'below' ? 'lowers' : 'raises'} what every team on the default spends per token; pass confirmBandChange: true to accept it.`,
      { direction: bandChange, price: facts.price, band },
    );
  }
  if (!input.confirm) {
    return refuse(
      'confirm_required',
      409,
      `This changes the ${tier} model for every team without its own row; pass confirm: true to apply it.`,
      { model, price: facts.price, floor: facts.floor, bandChange },
    );
  }
  return { ok: true, facts, bandChange };
}

// ── Suggestions ─────────────────────────────────────────────────────────────

export interface PlatformTierSuggestion {
  tier: string;
  /** `newer`: a later same-family release exists. `missing`: the effective model is not in the catalog. */
  kind: 'newer' | 'missing';
  /** The effective model today. */
  model: string;
  newer: string | null;
  facts: ModelFacts | null;
  /** Apply can run (certified, not retired); a band confirm may still be needed. */
  applicable: boolean;
  needsBandConfirm: boolean;
  /** One plain sentence for a reader. */
  why: string;
}

/**
 * The liveness audit's finding per tier, with the newer model's price, floor
 * and certification so a person can decide. An empty catalog yields nothing:
 * reporting every tier as stale off an empty list is the false alarm
 * `auditTierModels` refuses too.
 */
export function platformTierSuggestions(
  effective: Record<string, { provider: string; model: string }>,
  catalog: readonly CatalogEntry[],
  certifications: CertificationMap,
  now: number,
): PlatformTierSuggestion[] {
  if (catalog.length === 0) return [];
  // The undated ids only: a dated snapshot is the same release and would be
  // offered as the "newer" id otherwise.
  const live = catalog
    .filter((e) => e.provider === 'anthropic' && e.id.startsWith('claude-'))
    .filter((e) => !modelVariantFlags(e.id, { expiresAt: e.expiresAt ?? null }).snapshot)
    .map((e) => ({ id: e.id }));
  const audit = auditTierModels(effective, live);
  const out: PlatformTierSuggestion[] = [];
  for (const { tier, model } of audit.unknown) {
    out.push({
      tier, kind: 'missing', model, newer: null, facts: null, applicable: false, needsBandConfirm: false,
      why: `${model} is not in the live catalog any more; pick a live model for this tier.`,
    });
  }
  for (const { tier, model, newer } of audit.superseded) {
    const facts = describeModelFacts(newer, catalog, certifications, now);
    const band = TIER_PRICE_BANDS[tier as Tier];
    const price = facts.price?.input ?? null;
    const needsBandConfirm = !!band && price !== null && (price < band.minInput || price >= band.maxInput);
    const applicable = facts.certified && !facts.retired;
    const priceText = facts.price ? `${money(facts.price.input)} in / ${money(facts.price.output)} out per MTok` : 'price unknown';
    const floorText = facts.floor ? `Claude Code ${facts.floor} or newer` : facts.certified ? 'any current runner' : 'floor not certified';
    const why = applicable
      ? `A newer model exists for this tier: ${newer} (${priceText}, ${floorText}).${needsBandConfirm ? ' It is outside the tier price band, so applying it needs a band confirm.' : ''}`
      : facts.retired
        ? `${newer} is newer but already retired; nothing to apply.`
        : `A newer model exists for this tier: ${newer} (${priceText}), but it is not certified yet (${facts.certification}); Apply waits for the probe.`;
    out.push({ tier, kind: 'newer', model, newer, facts, applicable, needsBandConfirm, why });
  }
  return out;
}
