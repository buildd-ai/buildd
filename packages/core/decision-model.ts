/**
 * Which model answers a team's decision calls (`teams.decision_model`).
 *
 * Null (the default) is Jev on OpenRouter's System One API. A team may instead
 * name any model behind an OpenAI-compatible API, reached through OpenRouter's
 * chat API or the team's LiteLLM gateway (`litellm-gateway.ts`). The chat
 * endpoint answers the same typed questions with confidence from token
 * logprobs (`@builddai/ai-kit/decide`, `endpoint: { kind: 'chat' }`).
 *
 * `via: 'cloudflare'` runs a System One model on the team's Cloudflare
 * credential (`cloudflare-ai-gateway.ts`): Cloudflare's Clef (`clef`,
 * `clef-flash`) on Workers AI, or Jev through the team's AI Gateway. Clef is
 * served nowhere else; chat models do not go through Cloudflare yet.
 *
 * Thresholds were measured on Jev. A call site that auto-applies an answer
 * checks `isJevModel(result.model)` and records, but does not apply, another
 * model's pick until that model has its own eval.
 *
 * `byKind` overrides the model for one decision (`DECISION_MODEL_KINDS`), in
 * front of the team default: the best model differs by decision. Whether the
 * override's answer acts, and at what threshold, is still its stored
 * measurement for that (decision, model) (`decision-model-measurements.ts`).
 * The stored value may carry overrides with no default (`{ byKind }`): every
 * other decision stays on Jev.
 *
 * Pure: no DB, no env, no imports (the task route imports it statically).
 */

export type DecisionModelVia = 'openrouter' | 'litellm' | 'cloudflare';

export interface DecisionModelRoute {
  /** `systemone`: a System One model (Jev on OpenRouter or Cloudflare, Clef on Cloudflare). `chat`: any chat model, via OpenRouter or the gateway. */
  endpoint: 'systemone' | 'chat';
  model: string;
  via: DecisionModelVia;
}

/**
 * The decisions a team may give their own model, keyed by the name their
 * stored measurement uses, so an override and its measurement name the same
 * decision. Each one's call site passes its name to the access lookup.
 */
const KIND_LABELS = {
  task_category: 'Task category',
  task_role: 'Role pick',
  'buildd.orchestration_claim_hold': 'Start or wait',
  'buildd.orchestration_manifest_pick': 'Files a task touches',
  'buildd.orchestration_overlap_real': 'Overlap check',
  'buildd.orchestration_size_bucket': 'Task size',
  mission_strand_choice: 'Next mission strand',
  'buildd.merge_readiness': 'Merge readiness',
  'buildd.post_session_triage': 'Post-session triage',
  'buildd.failure_incident_triage': 'Failure triage',
  'buildd.scout_probe_selection': 'Scout probe pick',
  'buildd.visual_impact': 'Visual impact',
  'buildd.early_release': 'Early release',
  'buildd.spec_duplicate': 'Spec duplicates',
  'buildd.spec_area': 'Spec areas',
} as const;

export type DecisionModelKind = keyof typeof KIND_LABELS;

export const DECISION_MODEL_KINDS = Object.keys(KIND_LABELS) as DecisionModelKind[];

export function isDecisionModelKind(kind: unknown): kind is DecisionModelKind {
  return typeof kind === 'string' && Object.prototype.hasOwnProperty.call(KIND_LABELS, kind);
}

/** What Settings calls the decision ("Start or wait uses Clef"). */
export function decisionModelKindLabel(kind: DecisionModelKind): string {
  return KIND_LABELS[kind];
}

export type DecisionModelOverrides = Partial<Record<DecisionModelKind, DecisionModelRoute>>;

/** A route, and on the team's stored value, the per-decision overrides in front of it. */
export interface DecisionModelConfig extends DecisionModelRoute {
  byKind?: DecisionModelOverrides;
}

/** `teams.decision_model`: a default with optional overrides, or overrides alone (default Jev). */
export type DecisionModelSetting = DecisionModelConfig | { byKind: DecisionModelOverrides };

export const OPENROUTER_CHAT_BASE_URL = 'https://openrouter.ai/api/v1';

const MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;

const CLEF_RE = /^(?:@cf\/)?(?:cloudflare\/)?(clef(?:-flash)?)$/;

/** True for a Clef model id (`clef`, `clef-flash`, or `@cf/cloudflare/…`). Mirrors the kit's `isClefModel`. */
export function isClefModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && CLEF_RE.test(model.trim());
}

/** True for a Jev model id, versioned (`typesafe/jev-1.13-20260917`) or pinned. */
export function isJevModel(model: string | null | undefined): boolean {
  return typeof model === 'string' && /^typesafe\/jev-/.test(model);
}

type Normalized<T> = { ok: true; value: T } | { ok: false; error: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One route: the shared rules for the default and every override. */
function normalizeRoute(v: Record<string, unknown>): Normalized<DecisionModelRoute> {
  const rawModel = typeof v.model === 'string' ? v.model.trim() : '';
  const clef = CLEF_RE.exec(rawModel);
  const endpoint = v.endpoint ?? (clef ? 'systemone' : 'chat');
  if (endpoint !== 'systemone' && endpoint !== 'chat') return { ok: false, error: "decisionModel.endpoint must be 'systemone' or 'chat'" };
  const via = v.via ?? (clef ? 'cloudflare' : 'openrouter');
  if (via !== 'openrouter' && via !== 'litellm' && via !== 'cloudflare') return { ok: false, error: "decisionModel.via must be 'openrouter', 'litellm' or 'cloudflare'" };
  if (clef) {
    if (endpoint !== 'systemone' || via !== 'cloudflare') return { ok: false, error: 'Clef is a System One model served by Cloudflare only' };
    return { ok: true, value: { endpoint, model: clef[1], via } };
  }
  if (via === 'cloudflare' && (endpoint !== 'systemone' || !isJevModel(rawModel))) {
    return { ok: false, error: 'via Cloudflare, the decision model must be Clef or Jev' };
  }
  if (endpoint === 'systemone' && via === 'litellm') return { ok: false, error: 'a System One model is served by OpenRouter or Cloudflare only' };
  if (!MODEL_RE.test(rawModel)) return { ok: false, error: 'decisionModel.model must be a model id' };
  return { ok: true, value: { endpoint, model: rawModel, via } };
}

/** One override, by decision name. Null (or absent) is no override. */
export function normalizeDecisionModelOverride(kind: unknown, input: unknown): Normalized<DecisionModelRoute | null> {
  if (!isDecisionModelKind(kind)) return { ok: false, error: `unknown decision '${String(kind)}'` };
  if (input === null || input === undefined) return { ok: true, value: null };
  if (!isRecord(input)) return { ok: false, error: `decisionModel.byKind.${kind} must be an object or null` };
  const r = normalizeRoute(input);
  return r.ok ? r : { ok: false, error: `decisionModel.byKind.${kind}: ${r.error}` };
}

const hasRoute = (s: DecisionModelSetting | null | undefined): s is DecisionModelConfig =>
  !!s && typeof (s as DecisionModelConfig).model === 'string';

function combine(route: DecisionModelRoute | null, byKind: DecisionModelOverrides): DecisionModelSetting | null {
  const overrides = Object.keys(byKind).length > 0;
  if (!route) return overrides ? { byKind } : null;
  return overrides ? { ...route, byKind } : route;
}

/**
 * Normalise the team's stored value: an optional default and optional
 * per-decision overrides. Every override follows the default's rules; an
 * unknown decision is an error. Null clears it (back to Jev everywhere).
 */
export function normalizeDecisionModelSetting(input: unknown): Normalized<DecisionModelSetting | null> {
  if (input === null || input === undefined) return { ok: true, value: null };
  if (!isRecord(input)) return { ok: false, error: 'decisionModel must be an object or null' };
  const { byKind: rawByKind, ...rest } = input;
  const byKind: DecisionModelOverrides = {};
  if (rawByKind !== undefined && rawByKind !== null) {
    if (!isRecord(rawByKind)) return { ok: false, error: 'decisionModel.byKind must be an object' };
    for (const [kind, entry] of Object.entries(rawByKind)) {
      const r = normalizeDecisionModelOverride(kind, entry);
      if (!r.ok) return r;
      if (r.value) byKind[kind as DecisionModelKind] = r.value;
    }
  }
  const defaultGiven = rest.model !== undefined || rest.endpoint !== undefined || rest.via !== undefined;
  if (!defaultGiven && rawByKind !== undefined) return { ok: true, value: combine(null, byKind) };
  const route = normalizeRoute(rest);
  if (!route.ok) return route;
  return { ok: true, value: combine(route.value, byKind) };
}

/**
 * Normalise an operator-supplied route (a team default, an escalation or
 * challenger model). Null clears it (back to Jev); a malformed value is an
 * error string, so the API can say what was wrong. Overrides are validated
 * and kept when present; a model is required.
 */
export function normalizeDecisionModel(input: unknown): Normalized<DecisionModelConfig | null> {
  const r = normalizeDecisionModelSetting(input);
  if (!r.ok) return r;
  if (r.value && !hasRoute(r.value)) return { ok: false, error: 'decisionModel.model must be a model id' };
  return r as Normalized<DecisionModelConfig | null>;
}

/**
 * The stored value read defensively: a malformed default reads as Jev, and a
 * malformed or unknown override is dropped, keeping the rest.
 */
export function readDecisionModelSetting(stored: unknown): DecisionModelSetting | null {
  const whole = normalizeDecisionModelSetting(stored);
  if (whole.ok) return whole.value;
  if (!isRecord(stored)) return null;
  const { byKind: rawByKind, ...rest } = stored;
  const route = normalizeRoute(rest);
  const byKind: DecisionModelOverrides = {};
  if (isRecord(rawByKind)) {
    for (const [kind, entry] of Object.entries(rawByKind)) {
      const r = normalizeDecisionModelOverride(kind, entry);
      if (r.ok && r.value) byKind[kind as DecisionModelKind] = r.value;
    }
  }
  return combine(route.ok ? route.value : null, byKind);
}

/** The route one decision uses: its override, else the team default. Null is Jev. */
export function decisionModelFor(stored: unknown, kind?: string | null): DecisionModelRoute | null {
  const setting = readDecisionModelSetting(stored);
  const override = kind && isDecisionModelKind(kind) ? setting?.byKind?.[kind] : undefined;
  if (override) return override;
  if (!hasRoute(setting)) return null;
  const { byKind: _overrides, ...route } = setting;
  return route;
}

/** The team default alone (no overrides): what answers a decision with no override. */
export function readDecisionModel(stored: unknown): DecisionModelConfig | null {
  return decisionModelFor(stored);
}

/** The per-decision overrides alone. */
export function readDecisionModelOverrides(stored: unknown): DecisionModelOverrides {
  return readDecisionModelSetting(stored)?.byKind ?? {};
}

/** The stored value with one decision's override set (or cleared with null), the rest untouched. */
export function withDecisionModelForKind(stored: unknown, kind: DecisionModelKind, route: DecisionModelRoute | null): DecisionModelSetting | null {
  const byKind: DecisionModelOverrides = { ...readDecisionModelOverrides(stored) };
  if (route) byKind[kind] = route;
  else delete byKind[kind];
  return combine(readDecisionModel(stored), byKind);
}

/** The stored value with the team default replaced (null: Jev), keeping every override. */
export function withDecisionModelDefault(stored: unknown, route: DecisionModelRoute | null): DecisionModelSetting | null {
  const next = route ? { endpoint: route.endpoint, model: route.model, via: route.via } : null;
  return combine(next, readDecisionModelOverrides(stored));
}
