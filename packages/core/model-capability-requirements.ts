/**
 * Minimum Claude Code client (CLI) version required to serve a given model.
 *
 * The Anthropic API refuses a model request from an old CLI with a
 * deterministic 400: "Claude Code X.Y.Z does not support this model; version
 * A.B.C or newer is required." A `premium-plus` task burned two worker
 * sessions hitting exactly this before doing any work, because the runner's
 * CLI predated `claude-fable-5-1`'s floor and nothing checked at claim time.
 * See docs/design/model-tiers.md and the claim route's capability gate
 * (apps/web/src/app/api/workers/claim/route.ts) which reads this map before
 * dispatching a worker session.
 *
 * The @anthropic-ai/claude-agent-sdk npm package and the CLI binary it bundles
 * version in lockstep on the patch number today (SDK 0.3.N ships CLI 2.1.N —
 * confirmed against the registry's manifest.json for N = 231/238/251/260/272/280),
 * so a runner's reported CLI version can be compared directly against the
 * dotted version the API error names. This map only needs a new entry when a
 * future model raises the floor again — it is not tied to any one SDK release.
 */
import {
  certifiedFloor,
  compareCliVersions,
  findCertification,
  isCertified,
  runnerMeetsCertification,
  type CertificationMap,
} from './model-certification';

/**
 * Static floors, kept as the seed and as the anchor for "recognized": every
 * model released no later than the newest row here is served without a probe.
 * A NEWER release no longer needs a row: the certification probe
 * (model-certification.ts) records its floor without a deploy. Add a row only
 * to correct a probe, or for a model the catalog cannot see.
 */
export const MODEL_MIN_CLI_VERSION: Readonly<Record<string, string>> = {
  'claude-fable-5-1': '2.1.251',
  'claude-opus-5-5': '2.1.280',
  // Sonnet 5.5 support first shipped in Claude Code 2.1.284:
  // https://github.com/anthropics/claude-code/blob/main/CHANGELOG.md#21284
  'claude-sonnet-5-5': '2.1.284',
};

/**
 * The recorded CLI floor for `model`, or undefined. Own keys only, so an id
 * such as "constructor" never resolves to an Object.prototype member.
 */
function recordedFloor(model: string): string | undefined {
  return Object.hasOwn(MODEL_MIN_CLI_VERSION, model) ? MODEL_MIN_CLI_VERSION[model] : undefined;
}

export { compareCliVersions };

export type ModelCapabilityCheck =
  | { ok: true }
  | { ok: false; requiredVersion: string };

/**
 * Checks whether a runner reporting `runnerCliVersion` can serve `model`.
 *
 * The floor is the static table's, else the one certification learned
 * (`certifications`, see model-certification.ts).
 *
 * Fails OPEN when `model` has no known floor, or when `runnerCliVersion` is
 * missing/unparseable — an old runner build that predates version reporting
 * must not be retroactively blocked from every tier. The gate only fires when
 * we affirmatively know the client is too old.
 */
export function checkModelClientCapability(
  model: string,
  runnerCliVersion: string | null | undefined,
  certifications?: CertificationMap | null,
): ModelCapabilityCheck {
  const cert = findCertification(certifications, model);
  // The static row first; a probe-learned floor for a model the table never named.
  const required = recordedFloor(model) ?? (cert ? certifiedFloor(cert) : null);
  if (!required) return { ok: true };
  if (!runnerCliVersion) return { ok: true };
  if (compareCliVersions(runnerCliVersion, required) >= 0) return { ok: true };
  return { ok: false, requiredVersion: required };
}

/** The slice of a catalog entry the servability check needs (see model-catalog.ts). */
export interface CatalogModelRef {
  id: string;
  canonicalId: string | null;
  /** Release time, unix seconds. */
  created: number;
}

const releaseDay = (createdSeconds: number) => Math.floor(createdSeconds / 86_400);

/**
 * Builds the `isServable` filter for a catalog-driven tier pick. Fails CLOSED
 * on models the floor table cannot vouch for.
 *
 * `checkModelClientCapability` alone treats "no recorded floor" as "no floor",
 * which is only true for models released before the table's newest entry: when
 * someone last edited the table, those models already existed and nobody
 * recorded a floor for them. A catalog release NEWER than every model in the
 * table is different. Nobody has looked at it, so its floor is unknown, and a
 * new model has so far always raised the floor. Picking it lets the catalog
 * self-heal onto a model that old runners 400 on for every attempt, until
 * someone adds a row.
 *
 * So a model is servable from the catalog only when:
 *   - it has a recorded floor and the runner meets it (the usual gate, which
 *     still fails open on a missing runner version), or
 *   - it has no recorded floor and was released no later than the newest
 *     recorded model's release day. Same-day siblings count as recognized,
 *     matching pickTierModel's day granularity.
 *
 *   - it has no recorded floor but is centrally certified
 *     (`options.certifications`) and the runner meets its certified floor.
 *
 * An unrecognized model is refused whatever CLI the runner reports, because
 * a current CLI proves nothing about a floor that nobody has recorded. The
 * pick falls back to the newest recognized in-band release until the
 * certification probe certifies the new model, with no deploy. If no recorded model appears in
 * the catalog at all, every unrecorded model is unrecognized and the caller
 * lands on TIER_DEFAULTS. An unrecorded model with no release time (the feed
 * omitted `created`, which normalizes to 0) is also refused: missing data is
 * not evidence that the model is old.
 *
 * `options.onUnrecognized` is told about every refusal of an unrecorded
 * model, so the caller can say which release is being held back.
 *
 * This only governs the catalog step. An explicit registry row or a caller pin
 * is an operator's choice and still goes through `checkModelClientCapability`
 * alone.
 */
/** Why the catalog check refused a model it has no recorded floor for. */
export type UnrecognizedModelReason =
  /** Released after the newest model in MODEL_MIN_CLI_VERSION, and not (yet) certified. */
  | 'newer_than_floor_table'
  /** No model in MODEL_MIN_CLI_VERSION appears in the catalog, so nothing anchors "recognized". */
  | 'no_recorded_model_in_catalog'
  /** The feed gave no release time, so "released before the anchor" cannot be shown. */
  | 'missing_release_time';

export interface CatalogServabilityOptions {
  /** Called each time an in-band model is refused for having no recorded floor. */
  onUnrecognized?: (id: string, reason: UnrecognizedModelReason) => void;
  /**
   * Central certification records. A model the static table does not cover is
   * servable when certified and the runner meets its certified floor (a missing
   * runner version fails closed here: the alternative is an older in-band model).
   */
  certifications?: CertificationMap | null;
}

export function makeCatalogServabilityCheck(
  entries: readonly CatalogModelRef[],
  runnerCliVersion: string | null | undefined,
  options?: CatalogServabilityOptions,
): (id: string) => boolean {
  const floorKey = (e: CatalogModelRef): string | null => {
    if (recordedFloor(e.id)) return e.id;
    if (e.canonicalId !== null && recordedFloor(e.canonicalId)) return e.canonicalId;
    return null;
  };

  let newestRecordedDay = -Infinity;
  for (const e of entries) {
    if (floorKey(e) !== null) newestRecordedDay = Math.max(newestRecordedDay, releaseDay(e.created));
  }

  const byId = new Map(entries.map((e) => [e.id, e]));

  return (id) => {
    const entry = byId.get(id);
    if (!entry) return false;
    const key = floorKey(entry);
    if (key !== null) return checkModelClientCapability(key, runnerCliVersion).ok;

    const cert =
      findCertification(options?.certifications, entry.id) ??
      (entry.canonicalId ? findCertification(options?.certifications, entry.canonicalId) : null);
    if (isCertified(cert)) return runnerMeetsCertification(cert, runnerCliVersion);

    let reason: UnrecognizedModelReason | null = null;
    if (newestRecordedDay === -Infinity) reason = 'no_recorded_model_in_catalog';
    else if (!(entry.created > 0)) reason = 'missing_release_time';
    else if (releaseDay(entry.created) > newestRecordedDay) reason = 'newer_than_floor_table';

    if (reason === null) return true;
    options?.onUnrecognized?.(id, reason);
    return false;
  };
}
