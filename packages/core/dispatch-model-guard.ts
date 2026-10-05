/**
 * Dispatch-time guard on the model id a claim resolved.
 *
 * A model id can reach `tasks.context.model` from several places: a caller pin,
 * a tier-registry row, the live catalog, a tier-pool challenger arm, a
 * model-routing experiment treatment. If any of them names an id the runner's
 * Claude Code does not recognise, the CLI exits at launch
 * (`[claude-code:unrecognized_model]`), the worker dies before doing anything,
 * the slot is released and the task returns to `pending` — so the runner looks
 * idle and healthy while the queue is stranded.
 *
 * This is the claim-time check that stops that: validate the resolved id
 * against the known catalog BEFORE a worker is launched, and substitute a
 * known-good model when it fails. Pure — the catalog comes in as an argument.
 */
import { snapshotBase, type CatalogEntry } from './model-catalog';
import {
  MODEL_MIN_CLI_VERSION,
  makeCatalogServabilityCheck,
  type UnrecognizedModelReason,
} from './model-capability-requirements';
import { TIERS, bundledTierEntry, type Tier } from './model-tier-defaults';

/** Where a resolved model id came from, for the error record. */
export type DispatchModelSource =
  | 'pin'
  | 'tier_row'
  | 'tier_catalog'
  | 'tier_default'
  | 'router_alias'
  | 'routing_experiment'
  | 'tier_pool_arm';

export type DispatchModelRejectReason =
  /** Catalog is healthy and has no such Claude model — a typo or a retired id. */
  | 'not_in_catalog'
  | UnrecognizedModelReason;

export type DispatchModelVerdict =
  | { ok: true }
  | { ok: false; reason: DispatchModelRejectReason };

/** Pattern slug for the `worker_error_traces` row written when a model is rejected. */
export const DISPATCH_MODEL_REJECTED_PATTERN = 'dispatch_model_rejected';

const KNOWN_GOOD_IDS: ReadonlySet<string> = new Set([
  ...Object.keys(MODEL_MIN_CLI_VERSION),
  ...TIERS.map((t) => bundledTierEntry(t).model),
]);

/**
 * Is `model` an id Claude Code can be launched with at all?
 *
 * A recorded CLI floor is deliberately not judged here: a runner that is too
 * old for a KNOWN model is the claim route's `runner_capability` deferral
 * (checkModelClientCapability), which keeps the task pending for a newer
 * runner instead of swapping the model. This check is about ids nobody has
 * vouched for.
 *
 * Only Claude model ids are judged: an alias (`sonnet`), an OpenRouter slug or
 * a non-Anthropic id goes to a different client path this check knows nothing
 * about. An empty catalog means "we learned nothing", which fails open — the
 * same contract `fetchOpenRouterCatalog` documents.
 *
 * Beyond "is it in the catalog", a release newer than every model in
 * `MODEL_MIN_CLI_VERSION` is refused: its CLI floor is unrecorded, and every
 * new model so far has raised it. This is the rule `makeCatalogServabilityCheck`
 * already applies to catalog-picked tiers; the point here is that a pool arm, an
 * experiment arm or a pin used to bypass it.
 */
export function checkDispatchModel(
  model: string,
  catalog: readonly CatalogEntry[],
): DispatchModelVerdict {
  if (!model.startsWith('claude-')) return { ok: true };
  if (KNOWN_GOOD_IDS.has(model)) return { ok: true };
  if (catalog.length === 0) return { ok: true };

  const want = model.toLowerCase();
  const bare = snapshotBase(want);
  const entry =
    catalog.find((e) => e.id.toLowerCase() === want) ??
    catalog.find((e) => e.canonicalId?.toLowerCase() === want) ??
    catalog.find((e) => e.id.toLowerCase() === bare);
  if (!entry) return { ok: false, reason: 'not_in_catalog' };

  let reason: UnrecognizedModelReason | null = null;
  // No runner version: the floor is not this check's call (see above).
  const servable = makeCatalogServabilityCheck(catalog, null, {
    onUnrecognized: (_id, r) => { reason = r; },
  })(entry.id);
  if (servable) return { ok: true };
  return { ok: false, reason: reason ?? 'not_in_catalog' };
}

/** The tier a model id belongs to by family, for choosing a fallback for a pin. */
export function tierForModelId(model: string): Tier {
  const m = model.toLowerCase();
  if (m.includes('fable')) return 'premium-plus';
  if (m.includes('opus')) return 'premium';
  if (m.includes('haiku')) return 'budget';
  return 'standard';
}

export interface DispatchModelRejection {
  rejected: string;
  reason: DispatchModelRejectReason;
  source: DispatchModelSource;
  /** What was served instead. */
  fallback: string;
}

export interface GuardedModel {
  model: string;
  /** Source of the model finally served (the original source when nothing was rejected). */
  source: DispatchModelSource;
  rejection: DispatchModelRejection | null;
}

/**
 * Keep `resolved` if it passes; otherwise serve the first fallback that does,
 * ending at the tier's code-level default, which is always launchable.
 *
 * `fallbacks` are tried in order, typically the workspace/team tier entry. A
 * fallback that itself fails is skipped, so a bad tier row falls through to the
 * default instead of being served as the "known-good" model.
 */
export function guardDispatchModel(args: {
  resolved: string;
  source: DispatchModelSource;
  tier: Tier;
  fallbacks: ReadonlyArray<{ model: string; source: DispatchModelSource }>;
  catalog: readonly CatalogEntry[];
}): GuardedModel {
  const verdict = checkDispatchModel(args.resolved, args.catalog);
  if (verdict.ok) return { model: args.resolved, source: args.source, rejection: null };

  const next =
    args.fallbacks.find(
      (f) => f.model !== args.resolved && checkDispatchModel(f.model, args.catalog).ok,
    ) ?? { model: bundledTierEntry(args.tier).model, source: 'tier_default' as const };

  return {
    model: next.model,
    source: next.source,
    rejection: { rejected: args.resolved, reason: verdict.reason, source: args.source, fallback: next.model },
  };
}

/**
 * One line per (rejected id, source, reason), stable across tasks so the trace
 * dedupes into a single pattern: it names the id and where it came from, and
 * carries no task or worker identity.
 */
export function describeDispatchModelRejection(r: DispatchModelRejection): string {
  return `dispatch refused model "${r.rejected}" from ${r.source} (${r.reason}); served "${r.fallback}" instead`;
}
