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
export const MODEL_MIN_CLI_VERSION: Readonly<Record<string, string>> = {
  'claude-fable-5-1': '2.1.251',
  'claude-opus-5-5': '2.1.280',
};

/**
 * Compares two dot-separated numeric version strings, e.g. "2.1.251".
 * Returns -1 if `a` < `b`, 0 if equal, 1 if `a` > `b`. Missing trailing
 * components compare as 0 ("2.1" == "2.1.0").
 */
export function compareCliVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);
  const len = Math.max(partsA.length, partsB.length);
  for (let i = 0; i < len; i++) {
    const na = partsA[i] ?? 0;
    const nb = partsB[i] ?? 0;
    if (na !== nb) return na < nb ? -1 : 1;
  }
  return 0;
}

export type ModelCapabilityCheck =
  | { ok: true }
  | { ok: false; requiredVersion: string };

/**
 * Checks whether a runner reporting `runnerCliVersion` can serve `model`.
 *
 * Fails OPEN when `model` has no known floor, or when `runnerCliVersion` is
 * missing/unparseable — an old runner build that predates version reporting
 * must not be retroactively blocked from every tier. The gate only fires when
 * we affirmatively know the client is too old.
 */
export function checkModelClientCapability(
  model: string,
  runnerCliVersion: string | null | undefined,
): ModelCapabilityCheck {
  const required = MODEL_MIN_CLI_VERSION[model];
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
 * An unrecognized model is refused whatever CLI the runner reports, because
 * a current CLI proves nothing about a floor that nobody has recorded. The
 * pick falls back to the newest recognized in-band release. To adopt the
 * new model, add it to MODEL_MIN_CLI_VERSION. If no recorded model appears in
 * the catalog at all, every unrecorded model is unrecognized and the caller
 * lands on TIER_DEFAULTS.
 *
 * This only governs the catalog step. An explicit registry row or a caller pin
 * is an operator's choice and still goes through `checkModelClientCapability`
 * alone.
 */
export function makeCatalogServabilityCheck(
  entries: readonly CatalogModelRef[],
  runnerCliVersion: string | null | undefined,
): (id: string) => boolean {
  const recordedId = (e: CatalogModelRef) =>
    e.id in MODEL_MIN_CLI_VERSION || (e.canonicalId !== null && e.canonicalId in MODEL_MIN_CLI_VERSION);

  let newestRecordedDay = -Infinity;
  for (const e of entries) {
    if (recordedId(e)) newestRecordedDay = Math.max(newestRecordedDay, releaseDay(e.created));
  }

  const byId = new Map(entries.map((e) => [e.id, e]));

  return (id) => {
    const entry = byId.get(id);
    if (!entry) return false;
    if (recordedId(entry)) {
      const floorKey = id in MODEL_MIN_CLI_VERSION ? id : entry.canonicalId!;
      return checkModelClientCapability(floorKey, runnerCliVersion).ok;
    }
    return releaseDay(entry.created) <= newestRecordedDay;
  };
}
