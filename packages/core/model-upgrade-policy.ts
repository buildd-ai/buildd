/**
 * Team model-upgrade policy: certification says a model is SAFE to run
 * (model-certification.ts); this decides whether a team MOVES to it.
 *
 * It only governs the catalog step of tier resolution (model-tier-registry.ts,
 * step 6), where a tier follows the newest in-band release. Tiers stay semantic
 * (budget/standard/premium); the policy controls how far their model advances.
 *
 *   latest-compatible  the newest certified in-band model, as soon as it is
 *                      certified (the default: the behaviour before policies)
 *   soak               only once a model has been certified for `soakHours`
 *                      with no compatibility incident since
 *   manual             only models available when the team last adopted
 *                      (`adoptedThrough`); newer ones are announced, not used
 *
 * "Pinned" is not a mode: a registry row (manage_model_tiers action=set) pins a
 * tier to an exact model and the catalog step never runs for it. Explanations
 * report a pinned tier as such.
 *
 * Inheritance: workspace policy, else team policy, else the default.
 * Pure. Storage is model-upgrade-policy-store.ts.
 */
import {
  TIER_PRICE_BANDS,
  pickTierModel,
  type CatalogEntry,
  type CatalogTier,
} from './model-catalog';
import { makeCatalogServabilityCheck, type CatalogServabilityOptions } from './model-capability-requirements';
import { findCertification, isRetired, soakStart, type CertificationMap } from './model-certification';
import { describeCertification } from './model-certification-candidates';
import type { ModelDeprecation } from './model-certification';

export const MODEL_UPGRADE_MODES = ['latest-compatible', 'soak', 'manual'] as const;
export type ModelUpgradeMode = (typeof MODEL_UPGRADE_MODES)[number];

export const DEFAULT_SOAK_HOURS = 72;
const MAX_SOAK_HOURS = 24 * 90;

export interface ModelUpgradePolicy {
  mode: ModelUpgradeMode;
  /** soak only. */
  soakHours?: number;
  /** manual only: ISO time of the last adoption; models available by then may be used. */
  adoptedThrough?: string;
  /** Who set it and when, for the audit line. */
  setBy?: string | null;
  setAt?: string;
}

export type PolicySource = 'workspace' | 'team' | 'default';

export interface EffectiveUpgradePolicy {
  policy: ModelUpgradePolicy;
  source: PolicySource;
}

export const DEFAULT_MODEL_UPGRADE_POLICY: ModelUpgradePolicy = { mode: 'latest-compatible' };

export function isModelUpgradeMode(v: unknown): v is ModelUpgradeMode {
  return typeof v === 'string' && (MODEL_UPGRADE_MODES as readonly string[]).includes(v);
}

/** A stored value as a policy, or null when it is absent or malformed (read as "inherit"). */
export function readUpgradePolicy(raw: unknown): ModelUpgradePolicy | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isModelUpgradeMode(r.mode)) return null;
  const out: ModelUpgradePolicy = { mode: r.mode };
  if (r.mode === 'soak') {
    out.soakHours = typeof r.soakHours === 'number' && r.soakHours > 0 ? Math.min(r.soakHours, MAX_SOAK_HOURS) : DEFAULT_SOAK_HOURS;
  }
  if (r.mode === 'manual') {
    out.adoptedThrough = typeof r.adoptedThrough === 'string' ? r.adoptedThrough : typeof r.setAt === 'string' ? r.setAt : new Date(0).toISOString();
  }
  if (typeof r.setBy === 'string') out.setBy = r.setBy;
  if (typeof r.setAt === 'string') out.setAt = r.setAt;
  return out;
}

/**
 * Validate a requested policy for writing. Setting `manual` freezes tiers at
 * what is available now; `adopt` (adoptPolicy) moves that line forward.
 */
export function buildUpgradePolicy(
  input: { mode: unknown; soakHours?: unknown },
  actor: string | null,
  now: number,
): { policy: ModelUpgradePolicy } | { error: string } {
  if (!isModelUpgradeMode(input.mode)) {
    return { error: `mode must be one of ${MODEL_UPGRADE_MODES.join(', ')}` };
  }
  const iso = new Date(now).toISOString();
  const policy: ModelUpgradePolicy = { mode: input.mode, setBy: actor, setAt: iso };
  if (input.mode === 'soak') {
    const h = input.soakHours == null ? DEFAULT_SOAK_HOURS : Number(input.soakHours);
    if (!Number.isFinite(h) || h <= 0 || h > MAX_SOAK_HOURS) {
      return { error: `soakHours must be between 1 and ${MAX_SOAK_HOURS}` };
    }
    policy.soakHours = h;
  }
  if (input.mode === 'manual') policy.adoptedThrough = iso;
  return { policy };
}

/** Manual policy, with its adoption line moved to `now`: take every model certified so far. */
export function adoptPolicy(policy: ModelUpgradePolicy, actor: string | null, now: number): ModelUpgradePolicy {
  const iso = new Date(now).toISOString();
  return { ...policy, adoptedThrough: iso, setBy: actor, setAt: iso };
}

export function resolveUpgradePolicy(
  teamPolicy: unknown,
  workspacePolicy: unknown,
): EffectiveUpgradePolicy {
  const ws = readUpgradePolicy(workspacePolicy);
  if (ws) return { policy: ws, source: 'workspace' };
  const team = readUpgradePolicy(teamPolicy);
  if (team) return { policy: team, source: 'team' };
  return { policy: DEFAULT_MODEL_UPGRADE_POLICY, source: 'default' };
}

export type AdoptionVerdict =
  | { ok: true }
  | { ok: false; reason: 'soak' | 'manual'; eligibleAt: string | null };

/**
 * When `entry` became available to adopt: its certification (or last
 * incident, for soak) for a probed model, its release time for one the static
 * table vouches for.
 */
function availableSince(entry: CatalogEntry, certs: CertificationMap | null | undefined, forSoak: boolean): number {
  const cert = findCertification(certs, entry.id);
  if (cert) {
    const t = forSoak ? soakStart(cert) : cert.certifiedAt ? Date.parse(cert.certifiedAt) : null;
    if (t !== null && Number.isFinite(t)) return t;
  }
  return (entry.created || 0) * 1000;
}

/** May a team on `policy` move a tier to `entry` now? */
export function checkAdoption(
  entry: CatalogEntry,
  policy: ModelUpgradePolicy,
  certs: CertificationMap | null | undefined,
  now: number,
): AdoptionVerdict {
  if (isRetired(findCertification(certs, entry.id), now)) return { ok: false, reason: 'manual', eligibleAt: null };
  switch (policy.mode) {
    case 'latest-compatible':
      return { ok: true };
    case 'soak': {
      const ready = availableSince(entry, certs, true) + (policy.soakHours ?? DEFAULT_SOAK_HOURS) * 3_600_000;
      return ready <= now ? { ok: true } : { ok: false, reason: 'soak', eligibleAt: new Date(ready).toISOString() };
    }
    case 'manual': {
      const line = Date.parse(policy.adoptedThrough ?? policy.setAt ?? '');
      return Number.isFinite(line) && availableSince(entry, certs, false) <= line
        ? { ok: true }
        : { ok: false, reason: 'manual', eligibleAt: null };
    }
  }
}

/**
 * The catalog pick for a tier under a policy: newest in-band model the runner
 * can serve AND the policy lets the team adopt. Null when nothing qualifies
 * (the caller falls back to the bundled default).
 */
export function pickPolicyTierModel(
  tier: CatalogTier,
  catalog: readonly CatalogEntry[],
  opts: {
    policy: ModelUpgradePolicy;
    certifications?: CertificationMap | null;
    runnerCliVersion?: string | null;
    now: number;
    onUnrecognized?: CatalogServabilityOptions['onUnrecognized'];
  },
): CatalogEntry | null {
  const servable = makeCatalogServabilityCheck(catalog, opts.runnerCliVersion, {
    certifications: opts.certifications,
    onUnrecognized: opts.onUnrecognized,
  });
  const byId = new Map(catalog.map((e) => [e.id, e]));
  return pickTierModel(tier, catalog, 'anthropic', {
    isServable: (id) => servable(id) && checkAdoption(byId.get(id)!, opts.policy, opts.certifications, opts.now).ok,
  });
}

/** A runner version every certified floor clears: "what would the best runner be offered?" */
export const ANY_CURRENT_RUNNER = '999999.0.0';

/** The newest certified in-band model for a tier, ignoring team policy and runner age. */
export function latestCertifiedTierModel(
  tier: CatalogTier,
  catalog: readonly CatalogEntry[],
  certs: CertificationMap | null | undefined,
  now: number,
): CatalogEntry | null {
  return pickPolicyTierModel(tier, catalog, {
    policy: DEFAULT_MODEL_UPGRADE_POLICY,
    certifications: certs,
    runnerCliVersion: ANY_CURRENT_RUNNER,
    now,
  });
}

/** How a tier's current model was chosen. */
export type TierSelectionSource =
  | 'pinned_workspace'
  | 'pinned_team'
  | 'policy_service'
  | 'catalog'
  | 'default';

export interface TierAdoption {
  tier: CatalogTier;
  model: string;
  selectedBy: TierSelectionSource;
  /** One plain sentence: why this model. */
  why: string;
  /** The newest certified in-band model, when it differs from `model`. */
  newer: { model: string; certifiedAt: string | null } | null;
  /** Why `newer` is not in use, when it is not. */
  withheld: { reason: 'pinned' | 'manual' | 'soak'; eligibleAt: string | null } | null;
  deprecated: (ModelDeprecation & { retired: boolean }) | null;
}

/** `source` of a resolved TierEntry, as a selection source. */
export function selectionSourceOf(source: string | undefined): TierSelectionSource {
  switch (source) {
    case 'workspace': return 'pinned_workspace';
    case 'team': return 'pinned_team';
    case 'policy': return 'policy_service';
    case 'catalog': return 'catalog';
    default: return 'default';
  }
}

const MODE_LABEL: Record<ModelUpgradeMode, string> = {
  'latest-compatible': 'latest-compatible',
  soak: 'soak',
  manual: 'manual',
};

/**
 * Explain one tier: the model it runs, why, whether a newer certified model
 * exists, and why it was not adopted. `current` is the resolved tier entry
 * (resolveTierEntry with no runner version: the team-level answer).
 */
export function explainTierAdoption(args: {
  tier: CatalogTier;
  current: { model: string; source?: string };
  policy: EffectiveUpgradePolicy;
  catalog: readonly CatalogEntry[];
  certifications: CertificationMap;
  now: number;
}): TierAdoption {
  const { tier, current, policy, catalog, certifications, now } = args;
  const selectedBy = selectionSourceOf(current.source);
  const latest = latestCertifiedTierModel(tier, catalog, certifications, now);
  // Only an Anthropic tier has a catalog successor to compare against.
  const newer = latest && current.model.startsWith('claude-') && latest.id !== current.model && latest.canonicalId !== current.model
    && isNewerRelease(latest, current.model, catalog)
    ? { model: latest.id, certifiedAt: findCertification(certifications, latest.id)?.certifiedAt ?? null }
    : null;

  let withheld: TierAdoption['withheld'] = null;
  if (newer && latest) {
    if (selectedBy === 'pinned_team' || selectedBy === 'pinned_workspace') {
      withheld = { reason: 'pinned', eligibleAt: null };
    } else {
      const v = checkAdoption(latest, policy.policy, certifications, now);
      if (!v.ok) withheld = { reason: v.reason, eligibleAt: v.eligibleAt };
    }
  }

  const view = describeCertification(current.model, catalog, certifications, now);
  const deprecated = view.deprecated ? { ...view.deprecated, retired: view.retired } : null;

  const mode = MODE_LABEL[policy.policy.mode];
  let why: string;
  switch (selectedBy) {
    case 'pinned_workspace': why = 'Pinned for this workspace.'; break;
    case 'pinned_team': why = 'Pinned for the team.'; break;
    case 'policy_service': why = 'Chosen by the model policy service.'; break;
    case 'default': why = 'Built-in default (the live catalog had no eligible model).'; break;
    case 'catalog':
      why = policy.policy.mode === 'latest-compatible'
        ? 'Newest certified model in this tier’s price band.'
        : `Newest model in this tier’s price band allowed by the ${mode} upgrade policy.`;
      break;
  }
  return { tier, model: current.model, selectedBy, why, newer, withheld, deprecated };
}

/** Is `candidate` a later release than `model` (by catalog release day)? Unknown `model`: yes. */
function isNewerRelease(candidate: CatalogEntry, model: string, catalog: readonly CatalogEntry[]): boolean {
  const cur = catalog.find((e) => e.id === model || e.canonicalId === model);
  if (!cur) return true;
  return Math.floor(candidate.created / 86_400) > Math.floor(cur.created / 86_400);
}

export const CATALOG_TIERS = Object.keys(TIER_PRICE_BANDS) as CatalogTier[];

/** One sentence per tier for an MCP/text reader. Names models, never internal ids. */
export function describeAdoption(t: TierAdoption): string {
  const parts = [`${t.tier}: ${t.model} — ${t.why}`];
  if (t.deprecated) {
    const when = t.deprecated.retiresAt ? ` (retires ${t.deprecated.retiresAt.slice(0, 10)})` : '';
    parts.push(t.deprecated.retired ? `RETIRED${when}.` : `Deprecated${when}.`);
  }
  if (t.newer) {
    const why =
      t.withheld?.reason === 'pinned' ? 'withheld: the tier is pinned'
      : t.withheld?.reason === 'manual' ? 'withheld: manual upgrade policy (adopt to move)'
      : t.withheld?.reason === 'soak' ? `withheld: soaking until ${t.withheld.eligibleAt?.slice(0, 16).replace('T', ' ')} UTC`
      : 'available to newer runners';
    parts.push(`Newer certified: ${t.newer.model} (${why}).`);
  }
  return parts.join(' ');
}
