/**
 * Provider registry: the one place provider facts live. Pure, client-safe,
 * no SDK, environment, DB or secrets.
 *
 * One entry per credential provider: which credential shapes it has and where
 * each is stored, which surfaces it can serve (and, for every surface it
 * cannot, the reason a person is shown), which scopes may hold it, its
 * settings card and its MCP action. Wire facts (base URLs, auth header,
 * verify path) stay in `ROUTES`; an entry names its `RouteId`, it does not
 * copy URLs.
 *
 * Lists that used to be written by hand in several places derive from this:
 * `PROVIDER_KEY_CAPABILITIES[].purposes` (./provider-keys), buildd's
 * `BACKEND_REGISTRY[].credentialPurposes` and the tier-provider options and
 * "used by" copy on Settings → Model tiers.
 *
 * This lives in ai-kit, not `@buildd/core`, because core depends on ai-kit and
 * `PROVIDER_KEY_CAPABILITIES` must derive from it. Core re-exports it as
 * `@buildd/core/providers` and checks there that the string unions below match
 * its own `SecretPurpose` and `TierProvider`.
 */

import { ROUTES, type RouteId } from './routes';

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** Where a model credential is spent. */
export const SURFACES = ['chat', 'agent-claude', 'agent-codex', 'cloud-egress'] as const;
export type Surface = (typeof SURFACES)[number];

/** Who may hold a credential: the whole team, one workspace, or one person. */
export const CREDENTIAL_SCOPES = ['team', 'workspace', 'personal'] as const;
export type CredentialScope = (typeof CREDENTIAL_SCOPES)[number];

export const PROVIDER_IDS = [
  'claude-subscription',
  'anthropic',
  'codex-subscription',
  'openai',
  'openrouter',
  'litellm',
  'custom-endpoint',
] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

/**
 * `secrets.purpose` values that hold a model credential. A subset of buildd's
 * `SecretPurpose`; core asserts the subset relation at compile time.
 */
export type ModelCredentialPurpose =
  | 'inference_key'
  | 'anthropic_api_key'
  | 'decision_key'
  | 'oauth_token'
  | 'claude_credential'
  | 'openai_api_key'
  | 'codex_credential'
  | 'agent_endpoint';

/** The model-tier registry's providers (buildd's `TierProvider`; core asserts equality). */
export const TIER_PROVIDER_IDS = ['anthropic', 'openrouter', 'openai', 'openai-codex'] as const;
export type TierProviderId = (typeof TIER_PROVIDER_IDS)[number];

/** Agent backends the failover registry knows (buildd's `BackendId`). */
export type AgentBackendId = 'claude' | 'codex' | 'openrouter';

/** The agent surface each backend runs on. */
export const BACKEND_SURFACE: Readonly<Record<AgentBackendId, Surface>> = {
  claude: 'agent-claude',
  codex: 'agent-codex',
  // OpenRouter as a backend would run Claude Code against OpenRouter's
  // Anthropic-compatible root.
  openrouter: 'agent-claude',
};

// ── Shapes ───────────────────────────────────────────────────────────────────

/** One place a credential is stored, and which surfaces read that storage today. */
export interface CredentialStorage {
  purpose: ModelCredentialPurpose;
  /** `label` value for label-keyed purposes (`inference_key`). */
  label?: string;
  /**
   * Surfaces whose code reads this storage on `dev` today. This is the current
   * state, not the target: `surfaces` on the provider says what the provider
   * CAN serve, `readBy` says which readers already look here. The gap between
   * them is the parity work (see the provider parity design).
   */
  readBy: readonly Surface[];
}

export interface CredentialShape {
  id: 'api_key' | 'setup_token' | 'oauth_managed' | 'gateway' | 'endpoint';
  /** Canonical storage. Writes go here only. */
  storage: CredentialStorage;
  /** Read-only aliases, still read by some surface until they are consolidated. */
  legacy: readonly CredentialStorage[];
  /** A refresh family (the server rotates it), not a static value. */
  refreshes: boolean;
}

export type SurfaceSupport =
  | { ok: true; via: string }
  | { ok: false; reason: string; instead?: readonly ProviderId[] };

export interface ProviderDescriptor {
  id: ProviderId;
  label: string;
  /** ai-kit wire facts; absent for subscription seats and custom endpoints. */
  route?: RouteId;
  shapes: readonly CredentialShape[];
  /** Per surface: served (and how), or why not, rendered verbatim by UI, API and MCP. */
  surfaces: Readonly<Record<Surface, SurfaceSupport>>;
  scopes: readonly CredentialScope[];
  /** Scopes the registry allows but buildd does not deliver yet. */
  pendingScopes?: readonly CredentialScope[];
  /** Tier-registry providers this one satisfies, and on which surfaces. */
  tierProviders: ReadonlyArray<{ provider: TierProviderId; surfaces: readonly Surface[] }>;
  /** Failover backend whose "configured" check counts this provider's stored credentials. */
  backend?: AgentBackendId;
  settingsCard: { id: string; order: number; connectFlow: 'paste' | 'oauth' | 'form' };
  mcp: { action: 'manage_providers'; provider: ProviderId };
}

// ── Reasons (one string per impossible pair, shown verbatim) ────────────────

const R = {
  seatNotServer: 'A subscription seat signs in a runner; buildd’s server never spends a seat.',
  claudeSeatCloud: 'Cloud containers never receive a seat; only an owner seat set on your own Cloudflare Worker can.',
  codexHostOnly: 'Codex runs on host runners only.',
  codexWire: 'The Codex CLI speaks the OpenAI wire; this provider does not serve it.',
  claudeWire: 'Claude Code speaks the Anthropic Messages API; OpenAI has no Anthropic-compatible endpoint.',
  claudeSeatCodex: 'A Claude subscription signs in Claude Code; the Codex CLI cannot use it.',
  codexSeatClaude: 'A ChatGPT login signs in the Codex CLI; Claude Code cannot use it.',
  openAiCloud: 'Cloud runs reach models through an Anthropic-compatible route only, and OpenAI has none.',
  endpointChat: 'An endpoint is a route for agents, not a chat provider.',
  endpointCodex: 'The endpoint speaks only the Anthropic Messages API (no OpenAI root).',
} as const;

const no = (reason: string, instead?: readonly ProviderId[]): SurfaceSupport =>
  instead ? { ok: false, reason, instead } : { ok: false, reason };
const via = (how: string): SurfaceSupport => ({ ok: true, via: how });

/** Personal scope for a route-backed provider follows `ROUTES[route].personalKeys`. */
function routeScopes(route: RouteId): readonly CredentialScope[] {
  return ROUTES[route].personalKeys ? ['team', 'workspace', 'personal'] : ['team', 'workspace'];
}

// ── The registry ─────────────────────────────────────────────────────────────

/**
 * Array order is backend credential order: for one backend, a seat is listed
 * before an API key (what `credentialPurposes` has always listed first).
 * Display order is `settingsCard.order`.
 */
export const PROVIDER_REGISTRY: readonly ProviderDescriptor[] = [
  {
    id: 'claude-subscription',
    label: 'Claude subscription',
    shapes: [
      {
        id: 'oauth_managed',
        storage: { purpose: 'claude_credential', readBy: ['agent-claude'] },
        legacy: [],
        refreshes: true,
      },
      {
        id: 'setup_token',
        storage: { purpose: 'oauth_token', readBy: ['agent-claude'] },
        legacy: [],
        refreshes: false,
      },
    ],
    surfaces: {
      chat: no(R.seatNotServer, ['anthropic']),
      'agent-claude': via('Claude Code signed in with the seat'),
      'agent-codex': no(R.claudeSeatCodex, ['codex-subscription', 'openai']),
      'cloud-egress': no(R.claudeSeatCloud, ['anthropic']),
    },
    scopes: ['team', 'workspace', 'personal'],
    pendingScopes: ['personal'],
    tierProviders: [{ provider: 'anthropic', surfaces: ['agent-claude'] }],
    backend: 'claude',
    settingsCard: { id: 'claude-subscription', order: 2, connectFlow: 'oauth' },
    mcp: { action: 'manage_providers', provider: 'claude-subscription' },
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    route: 'anthropic',
    shapes: [
      {
        id: 'api_key',
        storage: { purpose: 'inference_key', label: 'anthropic', readBy: ['chat'] },
        legacy: [{ purpose: 'anthropic_api_key', readBy: ['chat', 'agent-claude', 'cloud-egress'] }],
        refreshes: false,
      },
    ],
    surfaces: {
      chat: via('Anthropic Messages API'),
      'agent-claude': via('Claude Code against the Anthropic API'),
      'agent-codex': no(R.codexWire, ['openrouter', 'litellm']),
      'cloud-egress': via('Anthropic API through the cloud egress proxy'),
    },
    scopes: routeScopes('anthropic'),
    tierProviders: [{ provider: 'anthropic', surfaces: ['chat', 'agent-claude', 'cloud-egress'] }],
    backend: 'claude',
    settingsCard: { id: 'anthropic', order: 1, connectFlow: 'paste' },
    mcp: { action: 'manage_providers', provider: 'anthropic' },
  },
  {
    id: 'codex-subscription',
    label: 'Codex (ChatGPT)',
    shapes: [
      {
        id: 'oauth_managed',
        storage: { purpose: 'codex_credential', readBy: ['agent-codex'] },
        legacy: [],
        refreshes: true,
      },
    ],
    surfaces: {
      chat: no(R.seatNotServer, ['openai']),
      'agent-claude': no(R.codexSeatClaude, ['claude-subscription', 'anthropic']),
      'agent-codex': via('Codex CLI signed in with the ChatGPT login, host runners only'),
      'cloud-egress': no(R.codexHostOnly),
    },
    scopes: ['team', 'workspace', 'personal'],
    pendingScopes: ['personal'],
    tierProviders: [{ provider: 'openai-codex', surfaces: ['agent-codex'] }],
    backend: 'codex',
    settingsCard: { id: 'codex-subscription', order: 4, connectFlow: 'oauth' },
    mcp: { action: 'manage_providers', provider: 'codex-subscription' },
  },
  {
    id: 'openai',
    label: 'OpenAI',
    route: 'openai',
    shapes: [
      {
        id: 'api_key',
        storage: { purpose: 'inference_key', label: 'openai', readBy: ['chat'] },
        legacy: [{ purpose: 'openai_api_key', readBy: ['agent-codex'] }],
        refreshes: false,
      },
    ],
    surfaces: {
      chat: via('OpenAI chat completions'),
      'agent-claude': no(R.claudeWire, ['openrouter', 'litellm']),
      'agent-codex': via('Codex CLI with API-key auth, host runners only'),
      'cloud-egress': no(R.openAiCloud, ['openrouter', 'litellm']),
    },
    scopes: routeScopes('openai'),
    tierProviders: [
      { provider: 'openai', surfaces: ['chat', 'agent-codex'] },
      { provider: 'openai-codex', surfaces: ['agent-codex'] },
    ],
    backend: 'codex',
    settingsCard: { id: 'openai', order: 3, connectFlow: 'paste' },
    mcp: { action: 'manage_providers', provider: 'openai' },
  },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    route: 'openrouter',
    shapes: [
      {
        id: 'api_key',
        storage: { purpose: 'inference_key', label: 'openrouter', readBy: ['chat'] },
        legacy: [{ purpose: 'decision_key', readBy: ['chat'] }],
        refreshes: false,
      },
    ],
    surfaces: {
      chat: via('OpenRouter chat completions'),
      'agent-claude': via('Claude Code against OpenRouter’s Anthropic-compatible root'),
      'agent-codex': via('Codex CLI against OpenRouter’s OpenAI root'),
      'cloud-egress': via('OpenRouter’s Anthropic-compatible root through the cloud egress proxy'),
    },
    scopes: routeScopes('openrouter'),
    tierProviders: [{ provider: 'openrouter', surfaces: ['chat', 'agent-claude', 'agent-codex', 'cloud-egress'] }],
    backend: 'openrouter',
    settingsCard: { id: 'openrouter', order: 5, connectFlow: 'paste' },
    mcp: { action: 'manage_providers', provider: 'openrouter' },
  },
  {
    id: 'litellm',
    label: 'LiteLLM gateway',
    route: 'litellm',
    shapes: [
      {
        id: 'gateway',
        // Agents and cloud egress read it only through an `agent_endpoint`
        // row of kind `gateway`, which references this credential.
        storage: { purpose: 'inference_key', label: 'litellm', readBy: ['chat', 'agent-claude', 'agent-codex', 'cloud-egress'] },
        legacy: [],
        refreshes: false,
      },
    ],
    surfaces: {
      chat: via('the gateway’s OpenAI-compatible root'),
      'agent-claude': via('the gateway’s Anthropic-compatible root'),
      'agent-codex': via('the gateway’s OpenAI-compatible root'),
      'cloud-egress': via('the gateway’s Anthropic-compatible root through the cloud egress proxy'),
    },
    scopes: routeScopes('litellm'),
    tierProviders: [],
    settingsCard: { id: 'litellm', order: 6, connectFlow: 'form' },
    mcp: { action: 'manage_providers', provider: 'litellm' },
  },
  {
    id: 'custom-endpoint',
    label: 'Custom endpoint',
    shapes: [
      {
        id: 'endpoint',
        // `agent_endpoint` rows of kind `gateway` (and, until the inline key
        // moves to the OpenRouter credential, `openrouter`) are routing
        // preferences; only `anthropic-compatible` is a credential of its own.
        // Codex reads `agent_endpoint` rows too, but only those routing kinds
        // (they have an OpenAI root); an `anthropic-compatible` row it refuses.
        storage: { purpose: 'agent_endpoint', readBy: ['agent-claude', 'cloud-egress'] },
        legacy: [],
        refreshes: false,
      },
    ],
    surfaces: {
      chat: no(R.endpointChat, ['litellm']),
      'agent-claude': via('Claude Code against the endpoint (ANTHROPIC_BASE_URL)'),
      'agent-codex': no(R.endpointCodex, ['litellm', 'openrouter']),
      'cloud-egress': via('the endpoint through the cloud egress proxy'),
    },
    scopes: ['team', 'workspace'],
    tierProviders: [],
    settingsCard: { id: 'custom-endpoint', order: 7, connectFlow: 'form' },
    mcp: { action: 'manage_providers', provider: 'custom-endpoint' },
  },
];

// ── Lookups ──────────────────────────────────────────────────────────────────

export function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (PROVIDER_IDS as readonly string[]).includes(value);
}

export function providerDescriptor(id: ProviderId): ProviderDescriptor {
  return PROVIDER_REGISTRY.find(p => p.id === id)!;
}

/** The provider reached through a route (one per route). */
export function providerForRoute(route: RouteId): ProviderDescriptor {
  return PROVIDER_REGISTRY.find(p => p.route === route)!;
}

export function surfaceSupport(id: ProviderId, surface: Surface): SurfaceSupport {
  return providerDescriptor(id).surfaces[surface];
}

/** Every storage of a provider, canonical first, then legacy aliases. */
export function providerStorages(p: ProviderDescriptor): CredentialStorage[] {
  return p.shapes.flatMap(s => [s.storage, ...s.legacy]);
}

// ── Derived lists ────────────────────────────────────────────────────────────

/**
 * `secrets.purpose` values the chat/inference resolver reads for a route's key,
 * canonical first. `PROVIDER_KEY_CAPABILITIES[].purposes`.
 */
export function chatKeyPurposes(route: RouteId): ModelCredentialPurpose[] {
  const p = providerForRoute(route);
  const out: ModelCredentialPurpose[] = [];
  for (const s of providerStorages(p)) {
    if (s.readBy.includes('chat') && !out.includes(s.purpose)) out.push(s.purpose);
  }
  return out;
}

/**
 * Purposes that make a failover backend "configured": every storage of the
 * providers mapped to it that the backend's agent surface reads today.
 * `BACKEND_REGISTRY[].credentialPurposes`.
 */
export function backendCredentialPurposes(backend: AgentBackendId): ModelCredentialPurpose[] {
  const surface = BACKEND_SURFACE[backend];
  const out: ModelCredentialPurpose[] = [];
  for (const p of PROVIDER_REGISTRY) {
    if (p.backend !== backend) continue;
    for (const s of providerStorages(p)) {
      if (s.readBy.includes(surface) && !out.includes(s.purpose)) out.push(s.purpose);
    }
  }
  return out;
}

/** Surfaces a tier provider can run on, across every registry provider that satisfies it. */
export function tierProviderSurfaces(tier: string): Surface[] {
  const out = new Set<Surface>();
  for (const p of PROVIDER_REGISTRY) {
    for (const t of p.tierProviders) {
      if (t.provider === tier) for (const s of t.surfaces) out.add(s);
    }
  }
  return SURFACES.filter(s => out.has(s));
}

export type TierUsedBy = 'agent runs, chat' | 'agent runs only' | 'chat only';

/** Which surfaces can run a tier on this provider, in Settings → Model tiers copy. */
export function tierUsedBy(provider: string): TierUsedBy {
  const surfaces = tierProviderSurfaces(provider);
  if (surfaces.length === 0) return 'agent runs, chat'; // unknown provider: the default, as before
  const chat = surfaces.includes('chat');
  const agent = surfaces.includes('agent-claude') || surfaces.includes('agent-codex');
  if (agent && !chat) return 'agent runs only';
  if (chat && !agent) return 'chat only';
  return 'agent runs, chat';
}

export interface TierProviderOption {
  id: TierProviderId;
  label: string;
  note?: string;
}

/**
 * Tier-registry providers in display order, with the note shown under each.
 * A note says what an API key or seat can and cannot run, matching
 * `tierProviderSurfaces` (a test holds them together).
 */
export const TIER_PROVIDER_OPTIONS: readonly TierProviderOption[] = [
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'openai', label: 'OpenAI', note: 'API key. Chat and other server-side calls, and Codex runs; Claude runs cannot use it.' },
  { id: 'openai-codex', label: 'OpenAI Codex', note: 'Runner only. Runs Codex on a Codex seat or an OpenAI API key, so chat cannot use it.' },
];
