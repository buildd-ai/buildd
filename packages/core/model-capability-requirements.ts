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
 * confirmed against the registry's manifest.json for N = 231/238/251/260/272),
 * so a runner's reported CLI version can be compared directly against the
 * dotted version the API error names. This map only needs a new entry when a
 * future model raises the floor again — it is not tied to any one SDK release.
 */
export const MODEL_MIN_CLI_VERSION: Readonly<Record<string, string>> = {
  'claude-fable-5-1': '2.1.251',
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
