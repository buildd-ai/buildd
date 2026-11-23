/**
 * What the Models and Keys pages show for one provider at one scope, derived
 * from `GET /api/providers` only. Pure and db-free (client components import
 * it).
 *
 * Nothing here restates registry facts: what a provider serves, why it cannot
 * serve a surface, which scopes it can be stored at and what each stored row
 * serves today all come from the response, so a registry change shows up here
 * without an edit.
 */
import type {
  CredentialPolicyValue,
  ListProvidersResponse,
  ProviderApiScope,
  ProviderCredentialSummary,
  ProviderListing,
  ProviderPolicySummary,
  ProviderShapeId,
  ProviderSurfaceId,
  ProviderEmbeddingResponse,
  ProviderLocalRunnerResponse,
  ProviderWritePermission,
} from '@buildd/shared';
import { isSupportedEmbeddingDimension } from '@buildd/shared';
import { EMBEDDING_PROVIDERS, type EmbeddingProviderId } from '@buildd/core/providers/embedding';

export const SURFACE_ORDER: readonly ProviderSurfaceId[] = ['chat', 'agent-claude', 'agent-codex', 'cloud-egress'];

export const SURFACE_LABEL: Record<ProviderSurfaceId, string> = {
  chat: 'Chat',
  'agent-claude': 'Claude agents',
  'agent-codex': 'Codex agents',
  'cloud-egress': 'Cloud agents',
};

/** The same surfaces mid-sentence: "Used for chat and Claude agents." */
const SURFACE_PHRASE: Record<ProviderSurfaceId, string> = {
  chat: 'chat',
  'agent-claude': 'Claude agents',
  'agent-codex': 'Codex agents',
  'cloud-egress': 'cloud agents',
};

export const SHAPE_NOUN: Record<ProviderShapeId, string> = {
  api_key: 'API key',
  gateway: 'Gateway',
  endpoint: 'Endpoint',
};

/** The LiteLLM gateway and custom endpoint forms: the Routing section further down this page. */

export const ADMINS_ONLY = 'Admins can change this.';
export const POLICY_BLOCKS_MINE = "Your team's policy doesn't use personal keys.";
export const MINE_NEEDS_PERSON = 'Personal keys belong to a signed-in person.';

type Can = ListProvidersResponse['caller']['can'];
export type WritePermission = keyof Can;

/**
 * Every permission a write of this shape at this scope needs, as the server
 * reports it (`writesTo[scope].permissions`, from `writePermissions` in
 * `@buildd/core/providers/manage`; a test holds them together). An Anthropic
 * or OpenAI key that agent runs read needs both the model-key and the
 * team-credential permission.
 */
export function writePermissionsFor(shape: Pick<ProviderListing['shapes'][number], 'writesTo'>, scope: ProviderApiScope): ProviderWritePermission[] {
  return shape.writesTo[scope]?.permissions ?? [];
}

/**
 * Surfaces the provider serves, and each one it can't with the registry's
 * reason. The page shows only `serves`: listing what a provider does not do
 * is the copy rule `not-this-its-that` (packages/core/copy-rules.ts).
 */
export function servesLine(p: Pick<ProviderListing, 'surfaces'>): {
  serves: ProviderSurfaceId[];
  not: { surface: ProviderSurfaceId; reason: string }[];
} {
  const serves: ProviderSurfaceId[] = [];
  const not: { surface: ProviderSurfaceId; reason: string }[] = [];
  for (const s of SURFACE_ORDER) {
    const support = p.surfaces[s];
    if (!support) continue;
    if (support.ok) serves.push(s);
    else not.push({ surface: s, reason: support.reason });
  }
  return { serves, not };
}

export function surfaceList(surfaces: readonly ProviderSurfaceId[]): string {
  const parts = SURFACE_ORDER.filter((s) => surfaces.includes(s)).map((s) => SURFACE_PHRASE[s]);
  return parts.length <= 1 ? (parts[0] ?? '') : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/** "Used for chat and Claude agents." */
export function usedFor(surfaces: readonly ProviderSurfaceId[]): string {
  return surfaces.length ? `Used for ${surfaceList(surfaces)}.` : 'Not used by anything.';
}

/** `word` is null for a provider with nothing set: the row shows its name and its action. */
export type RowState = { word: 'Needs attention' | 'Working' | 'Set' | `${string}'s key` | 'Team key' | null; tone: 'error' | 'success' | 'muted' };

/** "Acme's key": an inherited row names the team it comes from. "Team key" when the name is unknown. */
export function teamKeyWord(teamName?: string | null): NonNullable<RowState['word']> {
  const name = teamName?.trim();
  return name ? `${name}'s key` : 'Team key';
}

/** "Uses Acme's settings.": a workspace with nothing of its own. */
export function usesTeamLine(teamName?: string | null): string {
  const name = teamName?.trim();
  return name ? `Uses ${name}'s settings.` : 'Uses team settings.';
}

/** "Providers · Acme" for someone in more than one team, so a "Not set" says whose; "Providers" otherwise. */
export function providersTitle(data: Pick<ListProvidersResponse, 'teamName' | 'teamCount'> | null): string {
  const name = data?.teamName?.trim();
  return name && (data?.teamCount ?? 1) > 1 ? `Providers · ${name}` : 'Providers';
}

/** The one status word on a provider row. */
export function rowState(rows: readonly ProviderCredentialSummary[], inherited: readonly ProviderCredentialSummary[], teamName?: string | null): RowState {
  if (rows.some((r) => r.health === 'revoked' || r.lastVerificationError)) return { word: 'Needs attention', tone: 'error' };
  if (rows.some((r) => r.health === 'healthy')) return { word: 'Working', tone: 'success' };
  if (rows.length > 0) return { word: 'Set', tone: 'muted' };
  if (inherited.length > 0) return { word: teamKeyWord(teamName), tone: 'muted' };
  return { word: null, tone: 'muted' };
}

/** What a stored credential looks like on the row: "…a1b2", "Configured". */
export function maskedValue(row: Pick<ProviderCredentialSummary, 'shape' | 'last4'>): string {
  if (row.shape === 'gateway' || row.shape === 'endpoint') return 'Configured';
  return row.last4 ? `…${row.last4}` : 'Set';
}

/** True when the team accepts personal credentials anywhere (chat or agent runs). */
export function personalAccepted(policy: ProviderPolicySummary): boolean {
  return policy.chat.policy !== 'team' || policy.agent.policy !== 'team';
}

export type CardEdit =
  /** Paste a value for this shape (set / replace / remove). */
  | { kind: 'paste'; shape: ProviderShapeId }
  /** Set up with the form under Advanced. */
  | { kind: 'form' }
  | { kind: 'none' };

export interface CardView {
  /** Rows stored at this scope. */
  rows: ProviderCredentialSummary[];
  /** Workspace tab with no override: the team rows it falls back to. */
  inherited: ProviderCredentialSummary[];
  /** The scope is closed to this provider: the registry's reason. */
  closed: string | null;
  /** What the caller can do here. */
  edit: CardEdit;
  /** Shown when the caller can see but not change this scope. */
  readOnly: string | null;
}

export function cardView(p: ProviderListing, scope: ProviderApiScope, res: Pick<ListProvidersResponse, 'caller' | 'policy'>): CardView {
  const rows = (scope === 'team' ? p.set.team : scope === 'workspace' ? p.set.workspace : p.set.mine) ?? [];
  const inherited = scope === 'workspace' && rows.length === 0 ? p.set.team : [];
  const scopeState = p.scopes[scope];
  const closed = scopeState && !scopeState.ok ? scopeState.reason : null;
  const base = { rows, inherited };
  if (closed) return { ...base, closed, edit: { kind: 'none' }, readOnly: null };

  const pasteShape = p.shapes.find((s) => s.id === 'api_key' && s.writesTo[scope]);
  const formShape = p.shapes.find((s) => s.id === 'gateway' || s.id === 'endpoint');
  const edit: CardEdit = pasteShape ? { kind: 'paste', shape: pasteShape.id } : formShape ? { kind: 'form' } : { kind: 'none' };
  if (edit.kind === 'none') return { ...base, closed: null, edit, readOnly: null };

  if (scope === 'mine') {
    if (!res.caller.canSetMine) return { ...base, closed: null, edit: { kind: 'none' }, readOnly: MINE_NEEDS_PERSON };
    if (!personalAccepted(res.policy)) return { ...base, closed: null, edit: { kind: 'none' }, readOnly: POLICY_BLOCKS_MINE };
    return { ...base, closed: null, edit, readOnly: null };
  }
  const shape = pasteShape ?? formShape!;
  if (!writePermissionsFor(shape, scope).every((perm) => res.caller.can[perm])) return { ...base, closed: null, edit: { kind: 'none' }, readOnly: ADMINS_ONLY };
  return { ...base, closed: null, edit, readOnly: null };
}

// ── Whose key ────────────────────────────────────────────────────────────────

/** The one rule, for chat and agent runs alike. There is no setting for it. */
export const KEY_RULE = "Your key goes first. The team's key is the fallback.";

const STORED_POLICY_LABEL: Partial<Record<CredentialPolicyValue, string>> = {
  team: 'team keys only',
  personal_only: 'personal keys only',
};

/**
 * A team that stored a policy other than the default (before the setting was
 * removed) gets one line saying so, e.g. "This team uses team keys only.".
 * Null for every other team: the rule needs no line on Models.
 */
export function storedPolicyLine(policy: Pick<ProviderPolicySummary, 'credentialPolicy'>): string | null {
  const label = policy.credentialPolicy ? STORED_POLICY_LABEL[policy.credentialPolicy] : undefined;
  return label ? `This team uses ${label}.` : null;
}

/** The line on You › Keys: the stored exception if there is one, else the rule. */
export function keyRuleLine(policy: Pick<ProviderPolicySummary, 'credentialPolicy'>): string {
  return storedPolicyLine(policy) ?? KEY_RULE;
}

// ── Rows ─────────────────────────────────────────────────────────────────────

/** An Anthropic key is "Claude" to the reader; the row keeps the `claude` id (#agent-key, test ids). */
const ROW_NAME: Record<string, { id: string; label: string }> = {
  anthropic: { id: 'claude', label: 'Claude' },
};

export interface ProviderRowItem { id: string; label: string; provider: ProviderListing }

/** One row per listed provider, in registry order. */
/**
 * One credential card per provider that has something to connect. A provider
 * with no credential shape (`local_runner`: picked from a runner's advert, see
 * docs/specs/local-runner-provider.md §7.3) gets its own card, not a key row.
 */
export function providerRows(providers: readonly ProviderListing[]): ProviderRowItem[] {
  return providers
    .filter((p) => p.shapes.length > 0)
    .map((p) => ({ id: ROW_NAME[p.id]?.id ?? p.id, label: rowLabel(p), provider: p }));
}

function rowLabel(p: Pick<ProviderListing, 'id' | 'label'>): string {
  return ROW_NAME[p.id]?.label ?? p.label;
}

// ── Used for ─────────────────────────────────────────────────────────────────

/** Providers the team has connected (a team row exists), in registry order. */
export function connectedProviders(res: Pick<ListProvidersResponse, 'providers'>): ProviderListing[] {
  return res.providers.filter((p) => (p.set.team ?? []).length > 0);
}

export interface UsedForOption { value: string; label: string; disabled: boolean; description?: string }
export interface UsedForRow { surface: ProviderSurfaceId; label: string; value: string | null; options: UsedForOption[] }

/** "Automatic": the team made no pick for this surface; the resolver's own order decides. */
export const AUTOMATIC = '';

/**
 * One connected provider: no rows (it serves what it can, and `loneProviderLine`
 * says so). Two or more: one row per surface, every connected provider an
 * option, the ones a surface cannot use disabled with the registry's reason.
 */
export function usedForView(
  res: Pick<ListProvidersResponse, 'providers'>,
  assignments: Partial<Record<ProviderSurfaceId, string>>,
): UsedForRow[] | null {
  const connected = connectedProviders(res);
  if (connected.length < 2) return null;
  return SURFACE_ORDER.map((surface) => {
    const options: UsedForOption[] = connected.map((p) => {
      const support = p.surfaces[surface];
      if (support?.ok) {
        // Every team key rejected: picking it would route this surface to a key that fails.
        const broken = (p.set.team ?? []).every((r) => r.health === 'revoked' || !!r.lastVerificationError);
        return broken
          ? { value: p.id, label: rowLabel(p), disabled: true, description: 'Needs a working key' }
          : { value: p.id, label: rowLabel(p), disabled: false };
      }
      // The limit as a fact where someone acts ("Needs OpenAI or OpenRouter"), not a list of what it can't do.
      const instead = res.providers.filter((q) => support?.instead?.includes(q.id)).map(rowLabel);
      return { value: p.id, label: rowLabel(p), disabled: true, description: instead.length ? `Needs ${orList(instead)}` : support?.reason };
    });
    const picked = assignments[surface];
    const value = picked && options.some((o) => o.value === picked && !o.disabled) ? picked : null;
    return { surface, label: SURFACE_LABEL[surface], value, options };
  });
}

/** With one connected provider: "OpenRouter is used for chat, Claude agents and cloud agents." */
export function loneProviderLine(res: Pick<ListProvidersResponse, 'providers'>): string | null {
  const connected = connectedProviders(res);
  if (connected.length !== 1) return null;
  const p = connected[0];
  const { serves } = servesLine(p);
  return serves.length ? `${rowLabel(p)} is used for ${surfaceList(serves)}.` : null;
}

function orList(names: readonly string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}` : names[0] ?? '';
}

// ── Embeddings ───────────────────────────────────────────────────────────────

export interface EmbeddingRow {
  /** The provider shown as chosen: the stored pick, else Voyage (the default). */
  value: EmbeddingProviderId;
  model: string | null;
  options: UsedForOption[];
  /** Every provider but Voyage takes a model id. */
  needsModel: boolean;
}

/**
 * The one Embeddings row: Voyage (the default) and every connected provider
 * with an embeddings endpoint. Null when there is nothing to choose and
 * nothing chosen. A stored pick whose key is gone stays shown, disabled.
 */
export function embeddingView(res: Pick<ListProvidersResponse, 'providers'>, current: ProviderEmbeddingResponse, local: Pick<ProviderLocalRunnerResponse, 'runners'> | null = null): EmbeddingRow | null {
  const connected = new Set(connectedProviders(res).map((p) => p.id));
  const options: UsedForOption[] = [];
  for (const id of EMBEDDING_PROVIDERS) {
    const label = id === 'voyage' ? 'Voyage' : rowLabel(res.providers.find((p) => p.id === id) ?? { id, label: id });
    if (id === 'local_runner') {
      // Offered from a runner's advert (local-runner-provider §7.3), not from a
      // stored key: only while some runner advertises an embedding model. A
      // stored pick with no such runner stays shown, disabled.
      if (embeddingChoices(local).length > 0) options.push({ value: id, label, disabled: false });
      else if (current.provider === id) options.push({ value: id, label, disabled: true, description: 'Needs a runner' });
      continue;
    }
    if (id === 'voyage' || connected.has(id)) options.push({ value: id, label, disabled: false });
    else if (current.provider === id) options.push({ value: id, label, disabled: true, description: 'Needs a key' });
  }
  if (options.length < 2) return null;
  const value = current.provider ?? 'voyage';
  return {
    value,
    model: value === 'voyage' ? null : current.model,
    options,
    needsModel: value !== 'voyage',
  };
}

/** Under the row once the model changes: the vectors already stored came from the old one. */
export const EMBEDDING_REINDEX_LINE = 'Knowledge embedded with the old model is found by keyword until it is indexed again.';


// ── Local runner ─────────────────────────────────────────────────────────────

type LocalRunnerEntry = ProviderLocalRunnerResponse['runners'][number];

/** "Online" / "Offline": the same predicate as the runners page, decided server-side. */
export function runnerStateWord(online: boolean): 'Online' | 'Offline' {
  return online ? 'Online' : 'Offline';
}

/** "Last successful call 5m ago", or the plain fact that there has not been one. */
export function lastCallLine(at: string | null | undefined, now: Date = new Date()): string {
  if (!at) return 'No successful call';
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return 'No successful call';
  const s = Math.max(0, Math.round((now.getTime() - t) / 1000));
  if (s < 60) return 'Last successful call just now';
  const m = Math.round(s / 60);
  if (m < 60) return `Last successful call ${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `Last successful call ${h}h ago`;
  return `Last successful call ${Math.round(h / 24)}d ago`;
}

export interface LocalRunnerCardView {
  /** No runner has advertised models: the card gives way to a one-line hint. */
  empty: boolean;
  /** The status word on the row: the pinned runner's state; null with no pick. */
  state: { word: 'Online' | 'Offline' | 'Runner gone'; tone: 'success' | 'muted' | 'error' } | null;
  runners: LocalRunnerEntry[];
}

export const LOCAL_RUNNER_HINT = 'Install the runner on a machine with Ollama to use its models for chat and search.';

export function localRunnerCardView(res: ProviderLocalRunnerResponse): LocalRunnerCardView {
  const empty = res.runners.length === 0 && !res.runnerId;
  let state: LocalRunnerCardView['state'] = null;
  if (res.runnerId) {
    state = !res.runner ? { word: 'Runner gone', tone: 'error' }
      : res.runner.online ? { word: 'Online', tone: 'success' } : { word: 'Offline', tone: 'muted' };
  }
  return { empty, state, runners: res.runners };
}

/** Models of one capability a runner advertises, as picker options. An unsupported vector size is disabled with the reason. */
export function localModelOptions(runner: LocalRunnerEntry | undefined, capability: 'completion' | 'embedding'): UsedForOption[] {
  return (runner?.models ?? [])
    .filter((m) => m.capabilities.includes(capability))
    .map((m) => {
      const dims = m.dimensions;
      if (capability === 'embedding') {
        const ok = isSupportedEmbeddingDimension(dims);
        return { value: m.name, label: dims ? `${m.name} · ${dims}` : m.name, disabled: !ok, description: ok ? undefined : 'Size not supported' };
      }
      return { value: m.name, label: m.name, disabled: false };
    });
}

/** Runners that advertise at least one embedding model, with those models: the Embeddings row's choices. */
export function embeddingChoices(local: Pick<ProviderLocalRunnerResponse, 'runners'> | null): LocalRunnerEntry[] {
  return (local?.runners ?? []).filter((r) => localModelOptions(r, 'embedding').some((o) => !o.disabled));
}
