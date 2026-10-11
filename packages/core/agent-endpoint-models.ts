/**
 * What an agent model endpoint serves, and how buildd's model ids map onto it
 * (docs/design/agent-model-endpoint.md §4).
 *
 * A proxy key (LiteLLM especially) is often allowed only the proxy's own names
 * for a model: the undated `claude-haiku-4-5`, or `anthropic/claude-haiku-4-5`,
 * never the dated id buildd's tiers ask for. `GET <baseUrl>/v1/models` says
 * which names the key may use, so Verify can probe one of them and Settings can
 * offer them per buildd model.
 *
 * Invariant: a mapping buildd makes on its own (no person chose it) only ever
 * points a model at the same model under another name: same id once the
 * provider prefix, the release date and dots-vs-dashes are set aside. A person
 * may map anything to anything; buildd never crosses a family for them.
 *
 * Pure, except listAgentEndpointModels (one hardened GET through
 * net/public-address), so the helpers load in the runner and a plain bun test.
 */
import { fetchPublicNoRedirect, localDevHostsAllowed, type LookupAll } from './net/public-address';

type ModelMap = Record<string, string>;
type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

/** At most this many ids are kept from one `/v1/models` reply. */
export const MAX_LISTED_MODELS = 500;
/** A `/v1/models` body larger than this is treated as "no list". */
export const MAX_MODEL_LIST_BYTES = 1_000_000;
export const MODEL_LIST_TIMEOUT_MS = 5_000;

/** A model id we will show or send: printable ASCII, no spaces, bounded. */
const MODEL_ID_RE = /^[\x21-\x7e]{1,200}$/;

// ── Identity ──────────────────────────────────────────────────────────────────

/**
 * The id with what does not change the model removed: case, a `provider/`
 * prefix, a trailing release date (`-20251001` or `@20251001`), and dots
 * between digits (`4.5` = `4-5`).
 */
export function canonicalModelId(id: string): string {
  let s = id.trim().toLowerCase();
  s = s.slice(s.lastIndexOf('/') + 1);
  s = s.replace(/[-@]\d{8}$/, '');
  return s.replace(/(?<=\d)\.(?=\d)/g, '-');
}

/** A listed id that is `id` (exactly, else the same model under another name), or null. */
export function matchListedModel(id: string, listed: readonly string[]): string | null {
  if (listed.includes(id)) return id;
  return findListedEquivalent(id, listed);
}

/**
 * A listed id that is the same model as `model` under another name, never
 * `model` itself. Unprefixed names first, then the endpoint's order.
 */
export function findListedEquivalent(model: string, listed: readonly string[]): string | null {
  if (listed.includes(model)) return null;
  const c = canonicalModelId(model);
  const same = listed.filter((m) => canonicalModelId(m) === c);
  return same.find((m) => !m.includes('/')) ?? same[0] ?? null;
}

const FAMILY_RANK = { haiku: 0, sonnet: 1, opus: 2, fable: 3 } as const;
export type ClaudeFamily = keyof typeof FAMILY_RANK;

/** The Claude family an id names, or null for anything that is not a Claude model id. */
export function claudeFamily(id: string): ClaudeFamily | null {
  const c = canonicalModelId(id);
  if (!/(^|-)claude(-|$)/.test(c)) return null;
  const m = c.match(/(?:^|-)(haiku|sonnet|opus|fable)(?:-|$)/);
  return m ? (m[1] as ClaudeFamily) : null;
}

/** Listed Claude models, cheapest family first (endpoint order within a family), at most `max`. */
export function usableListedModels(listed: readonly string[], max = 3): string[] {
  return listed
    .map((id, i) => ({ id, i, f: claudeFamily(id) }))
    .filter((x): x is { id: string; i: number; f: ClaudeFamily } => x.f !== null)
    .sort((a, b) => FAMILY_RANK[a.f] - FAMILY_RANK[b.f] || a.i - b.i)
    .slice(0, max)
    .map((x) => x.id);
}

// ── Verify probe ──────────────────────────────────────────────────────────────

export type ProbeRule = 'alias' | 'listed' | 'equivalent' | 'cheapest' | 'first-alias' | 'default';

/**
 * The wire model Verify sends, from the endpoint's list when it has one
 * (`listed` null = no list: the reply was missing, refused or not a list).
 *
 *   (a) the alias target of the verify model, when listed or there is no list
 *   (b) the verify model itself, when listed
 *   (c) the same model under another name
 *   (d) the cheapest listed Claude model (haiku < sonnet < opus)
 *   (e) the first alias target, a listed one first
 *   (f) the verify model
 *
 * With no list this is (a), (e), (f): what Verify did before lists existed.
 */
export function selectProbeModel(input: { verifyModel: string; aliases: ModelMap; listed: readonly string[] | null }): { model: string; rule: ProbeRule } {
  const { verifyModel, aliases, listed } = input;
  const target = aliases[verifyModel];
  if (target && (!listed || listed.includes(target))) return { model: target, rule: 'alias' };
  if (listed && listed.length > 0) {
    if (listed.includes(verifyModel)) return { model: verifyModel, rule: 'listed' };
    const eq = findListedEquivalent(verifyModel, listed);
    if (eq) return { model: eq, rule: 'equivalent' };
    const [cheapest] = usableListedModels(listed, 1);
    if (cheapest) return { model: cheapest, rule: 'cheapest' };
  }
  const targets = Object.values(aliases);
  const first = (listed ? targets.find((t) => listed.includes(t)) : undefined) ?? targets[0];
  if (first) return { model: first, rule: 'first-alias' };
  return { model: verifyModel, rule: 'default' };
}

// ── Mapping ───────────────────────────────────────────────────────────────────

/**
 * Same-model aliases for `models` the endpoint does not list under that id
 * but does list under another name. Never one the person already set, never
 * across families. Empty without a list.
 */
export function deriveModelAliases(input: { models: readonly string[]; explicit: ModelMap; listed: readonly string[] | null }): ModelMap {
  const out: ModelMap = {};
  if (!input.listed) return out;
  for (const m of input.models) {
    if (input.explicit[m] !== undefined || input.listed.includes(m)) continue;
    const eq = findListedEquivalent(m, input.listed);
    if (eq) out[m] = eq;
  }
  return out;
}

/**
 * Where a row's value came from. `alias`: the person's saved mapping.
 * `listed`: the endpoint serves the id as is. `registry`: the team already
 * routes this tier to that model elsewhere (another provider or surface).
 * `equivalent`: the same model under another name. null: nothing matched.
 */
export type EndpointModelSource = 'alias' | 'listed' | 'registry' | 'equivalent';

export interface EndpointModelRow {
  /** The native id buildd asks for. */
  model: string;
  /** The tiers that route to it (empty for a saved alias no tier uses). */
  tiers: string[];
  /** The listed id to send instead; null = send `model` as is. */
  value: string | null;
  source: EndpointModelSource | null;
  /** Whether the endpoint lists what would be sent. Null without a list. */
  served: boolean | null;
}

/**
 * One row per model buildd will ask for, prefilled deterministically:
 * the person's alias, else the id as is when listed, else a listed model the
 * team's tier registry already routes the tier to elsewhere (`hints`), else
 * the same model under another name. Saved aliases for models no tier asks
 * for are kept as rows of their own.
 */
export function buildEndpointModelRows(input: {
  wanted: ReadonlyArray<{ model: string; tiers: readonly string[] }>;
  explicit: ModelMap;
  hints: Record<string, readonly string[]>;
  listed: readonly string[] | null;
}): EndpointModelRow[] {
  const { explicit, hints, listed } = input;
  const order: string[] = [];
  const tiers = new Map<string, string[]>();
  for (const w of input.wanted) {
    if (!tiers.has(w.model)) { order.push(w.model); tiers.set(w.model, []); }
    const t = tiers.get(w.model)!;
    for (const x of w.tiers) if (!t.includes(x)) t.push(x);
  }
  for (const k of Object.keys(explicit)) if (!tiers.has(k)) { order.push(k); tiers.set(k, []); }

  return order.map((model): EndpointModelRow => {
    const base = { model, tiers: tiers.get(model)! };
    const alias = explicit[model];
    if (alias !== undefined) return { ...base, value: alias, source: 'alias', served: listed ? listed.includes(alias) : null };
    if (!listed) return { ...base, value: null, source: null, served: null };
    if (listed.includes(model)) return { ...base, value: null, source: 'listed', served: true };
    for (const h of hints[model] ?? []) {
      const hit = matchListedModel(h, listed);
      if (hit) return { ...base, value: hit, source: 'registry', served: true };
    }
    const eq = findListedEquivalent(model, listed);
    if (eq) return { ...base, value: eq, source: 'equivalent', served: true };
    return { ...base, value: null, source: null, served: false };
  });
}

function words(id: string): Set<string> {
  return new Set(canonicalModelId(id).split(/[-_.:]+/).filter((w) => /^[a-z]{3,}$/.test(w)));
}

/**
 * The listed ids worth offering a decision model for `model`: a cheap lexical
 * prefilter (shared words, same Claude family), at most `max`, best first.
 */
export function suggestionCandidates(model: string, listed: readonly string[], max = 20): string[] {
  const mine = words(model);
  const fam = claudeFamily(model);
  return listed
    .map((id, i) => {
      let s = 0;
      for (const w of words(id)) if (mine.has(w)) s += 2;
      if (fam && claudeFamily(id) === fam) s += 3;
      return { id, i, s };
    })
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .slice(0, max)
    .map((x) => x.id);
}

// ── The list ──────────────────────────────────────────────────────────────────

/**
 * Ids from a `/v1/models` reply: OpenAI-style `{ data: [{ id }] }` or
 * Anthropic-style `{ data: [{ id }], has_more }` (first page only). Ids that
 * are not plain printable names are dropped; at most MAX_LISTED_MODELS.
 * Null when it is not a list.
 */
export function parseModelList(body: unknown): string[] | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const data = (body as { data?: unknown }).data;
  if (!Array.isArray(data)) return null;
  const out: string[] = [];
  for (const m of data) {
    const id = m && typeof m === 'object' ? (m as { id?: unknown }).id : undefined;
    if (typeof id !== 'string' || !MODEL_ID_RE.test(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= MAX_LISTED_MODELS) break;
  }
  return out;
}

async function readBounded(res: Response, maxBytes: number): Promise<string | null> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

/**
 * `GET <baseUrl>/v1/models` with the endpoint's own auth header: public hosts
 * only, no redirects, a short deadline and a bounded read. The ids, or null
 * for any failure or a reply that is not a list (404/405, an HTML page, a
 * refusal). Never throws, and nothing of the reply but parsed ids comes back.
 */
export async function listAgentEndpointModels(
  route: { baseUrl: string; apiKey: string; authHeader: 'authorization' | 'x-api-key'; headers?: Record<string, string> },
  opts: { fetcher?: Fetcher; lookup?: LookupAll; timeoutMs?: number } = {},
): Promise<string[] | null> {
  const headers: Record<string, string> = { accept: 'application/json', 'anthropic-version': '2023-06-01' };
  if (route.authHeader === 'x-api-key') headers['x-api-key'] = route.apiKey;
  else headers.authorization = `Bearer ${route.apiKey}`;
  for (const [k, v] of Object.entries(route.headers ?? {})) headers[k.toLowerCase()] = v;
  try {
    const res = await fetchPublicNoRedirect(`${route.baseUrl}/v1/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(opts.timeoutMs ?? MODEL_LIST_TIMEOUT_MS),
    }, { fetcher: opts.fetcher, lookup: opts.lookup, allowLocal: localDevHostsAllowed() });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return null;
    }
    const text = await readBounded(res, MAX_MODEL_LIST_BYTES);
    if (text === null) return null;
    return parseModelList(JSON.parse(text));
  } catch {
    return null;
  }
}
