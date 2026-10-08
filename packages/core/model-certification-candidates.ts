/**
 * Which catalog models need a certification probe, and what each model's
 * certification looks like from outside (the view MCP, Settings and Home read).
 * Pure: catalog, records and clock are arguments. See model-certification.ts.
 */
import {
  MIN_CONTEXT_TOKENS,
  TIER_PRICE_BANDS,
  modelVariantFlags,
  type CatalogEntry,
} from './model-catalog';
import { makeCatalogServabilityCheck } from './model-capability-requirements';
import {
  findCertification,
  isRetired,
  needsProbe,
  type CertificationMap,
  type CertificationState,
  type ModelCertification,
  type ModelDeprecation,
} from './model-certification';

/** The tier price band a catalog entry falls in, or null when it is outside every band. */
function inSomeBand(e: CatalogEntry): boolean {
  return Object.values(TIER_PRICE_BANDS).some((b) => e.input >= b.minInput && e.input < b.maxInput);
}

/** A catalog entry a tier pick could ever land on: Anthropic, tool-capable, big enough, priced in a band. */
export function isTierCandidate(e: CatalogEntry): boolean {
  if (e.provider !== 'anthropic' || !e.id.startsWith('claude-')) return false;
  if (e.contextLength < MIN_CONTEXT_TOKENS || !inSomeBand(e)) return false;
  const flags = modelVariantFlags(e.id, { expiresAt: e.expiresAt ?? null });
  return !flags.preview && !flags.snapshot;
}

/**
 * The set of in-band models the static floor table does not vouch for. These,
 * and only these, are what certification exists to decide.
 */
export function unrecognizedCatalogModels(catalog: readonly CatalogEntry[]): CatalogEntry[] {
  const refused = new Set<string>();
  const check = makeCatalogServabilityCheck(catalog, null, { onUnrecognized: (id) => refused.add(id) });
  const out: CatalogEntry[] = [];
  for (const e of catalog) {
    if (!isTierCandidate(e)) continue;
    check(e.id);
    if (refused.has(e.id)) out.push(e);
  }
  return out;
}

/**
 * Models a runner at `cliVersion` should probe, newest release first. A model
 * the table already recognizes is never offered (its certification is the
 * baseline), nor is one past its retirement date.
 */
export function probeCandidates(
  catalog: readonly CatalogEntry[],
  certs: CertificationMap,
  cliVersion: string,
  now: number,
): CatalogEntry[] {
  return unrecognizedCatalogModels(catalog)
    .filter((e) => {
      const cert = findCertification(certs, e.id);
      if (isRetired(cert, now)) return false;
      if (e.expiresAt && e.expiresAt * 1000 <= now) return false;
      return needsProbe(cert, cliVersion, now);
    })
    .sort((a, b) => b.created - a.created);
}

/** One model's certification as a reader sees it. Never exposes lease ids. */
export interface CertificationView {
  model: string;
  /** `baseline`: covered by the static floor table, certified without a probe. */
  state: CertificationState | 'baseline';
  minCliVersion: string | null;
  certifiedAt: string | null;
  releasedAt: string | null;
  contextLength: number | null;
  deprecated: ModelDeprecation | null;
  retired: boolean;
  lastProbe: { at: string | null; cliVersion: string | null; error: string | null; attempts: number } | null;
}

/**
 * Describe `model`'s certification: its stored record when it has one; else
 * `baseline` when the static table vouches for it, `discovered` when it is an
 * in-band catalog release nobody has probed yet. Deprecation comes from an
 * admin mark first, then the provider catalog's expiry date.
 */
export function describeCertification(
  model: string,
  catalog: readonly CatalogEntry[],
  certs: CertificationMap,
  now: number,
): CertificationView {
  const entry = catalog.find((e) => e.id === model || e.canonicalId === model) ?? null;
  const cert: ModelCertification | null = findCertification(certs, model);
  const unrecognized = new Set(unrecognizedCatalogModels(catalog).map((e) => e.id));

  const catalogDeprecation: ModelDeprecation | null =
    entry?.expiresAt && entry.expiresAt * 1000 - now < 120 * 86_400_000
      ? { source: 'catalog', at: new Date(now).toISOString(), retiresAt: new Date(entry.expiresAt * 1000).toISOString() }
      : null;
  const deprecated = cert?.deprecated ?? catalogDeprecation;
  const retired = !!deprecated?.retiresAt && Date.parse(deprecated.retiresAt) <= now;

  const state: CertificationView['state'] = cert
    ? cert.state
    : entry && unrecognized.has(entry.id)
      ? 'discovered'
      : 'baseline';

  return {
    model,
    state,
    minCliVersion: cert ? (cert.minCliVersion ?? cert.minVerifiedCliVersion ?? null) : null,
    certifiedAt: cert?.certifiedAt ?? null,
    releasedAt: entry?.created ? new Date(entry.created * 1000).toISOString() : cert?.releasedAt ? new Date(cert.releasedAt * 1000).toISOString() : null,
    contextLength: entry?.contextLength ?? cert?.contextLength ?? null,
    deprecated,
    retired,
    lastProbe: cert
      ? {
          at: cert.probe.lastProbedAt ?? null,
          cliVersion: cert.probe.lastCliVersion ?? null,
          error: cert.probe.lastError ?? null,
          attempts: cert.probe.attempts,
        }
      : null,
  };
}
