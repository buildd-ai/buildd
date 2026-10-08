/**
 * Semantic capability discovery over the EXISTING connector system: "what
 * could satisfy observability:query (or deployment:read) here, and what stands
 * between this role and it?" Pure; the db read is connector-capabilities-store.ts.
 *
 * Capabilities are abstract; tools stay native; credentials stay brokered;
 * runtime needs are a separate axis. So this module:
 *
 * - names needs with a deliberately small vocabulary (`domain:verb`, verbs
 *   read | query | write) instead of modelling provider tools;
 * - maps a provider to the needs it serves only through PROVIDER_PROFILES
 *   (catalog slug → domains/verbs, whether mounting it exposes write tools,
 *   whether the provider admits Buildd-run clients), falling back to the
 *   catalog entry's category for anything without a profile;
 * - reads, never changes, connectors, workspace enablement, role
 *   connectorRefs, credential health, the team's catalog policy and the
 *   Operator grant. It returns no credential material and no owner team.
 *
 * "Read" is not a tool filter. Mounting a connector exposes every native tool
 * it lists, so a read need on a read/write provider reports
 * `writeToolsExposed: true`; nothing here narrows the provider's surface.
 */
import { deriveConnectorStatus, needsReconnect, type ConnectorCredentialSnapshot } from './connector-status';
import { normalizeConnectorUrl, type ConnectorCatalogCategory, type ResolvedCatalogEntry } from './connector-catalog';

export const CAPABILITY_DOMAINS = [
  'observability', 'deployment', 'database', 'analytics', 'work_tracking', 'docs', 'source_control',
] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

export const CAPABILITY_VERBS = ['read', 'query', 'write'] as const;
export type CapabilityVerb = (typeof CAPABILITY_VERBS)[number];

export interface ParsedCapability { domain: CapabilityDomain; verb: CapabilityVerb }

/** `domain:verb`, or a bare domain meaning read. Anything else is null, never a guess. */
export function parseCapability(raw: string): ParsedCapability | null {
  const [d, v = 'read', extra] = raw.trim().toLowerCase().split(':');
  if (extra !== undefined) return null;
  if (!(CAPABILITY_DOMAINS as readonly string[]).includes(d)) return null;
  if (!(CAPABILITY_VERBS as readonly string[]).includes(v)) return null;
  return { domain: d as CapabilityDomain, verb: v as CapabilityVerb };
}

export const CAPABILITY_VOCABULARY = CAPABILITY_DOMAINS.flatMap(d => CAPABILITY_VERBS.map(v => `${d}:${v}`));

/** Whether a provider admits the agent runtimes Buildd runs, as far as we know. */
export type ProviderCompatibility = 'documented' | 'unknown_until_tested' | 'not_recorded';

interface ProviderProfile {
  serves: Partial<Record<CapabilityDomain, CapabilityVerb[]>>;
  /** What mounting the connector exposes, whatever the need was. */
  writeToolsExposed: boolean | 'unknown';
  compatibility: ProviderCompatibility;
  compatibilityNote?: string;
  /** Said when the provider covers the domain but not the verb asked for. */
  partialNote?: Partial<Record<CapabilityDomain, string>>;
}

/**
 * Provider metadata, keyed by catalog slug. Only what discovery needs to rank
 * and warn; the provider's own tools/list stays the authority on what it does.
 */
const PROVIDER_PROFILES: Record<string, ProviderProfile> = {
  axiom: {
    serves: { observability: ['read', 'query'] },
    writeToolsExposed: false,
    compatibility: 'documented',
    compatibilityNote: 'Axiom documents its hosted MCP for Claude Code and Codex over OAuth.',
  },
  vercel: {
    serves: { deployment: ['read', 'write'], observability: ['read'] },
    writeToolsExposed: true,
    compatibility: 'unknown_until_tested',
    compatibilityNote: 'Vercel admits only MCP clients it has approved. Whether it admits a Buildd-run agent is unknown until a run has used it.',
    partialNote: { observability: 'Deployment and build logs only; no query language over telemetry.' },
  },
  sentry: { serves: { observability: ['read', 'query'] }, writeToolsExposed: true, compatibility: 'not_recorded' },
  posthog: { serves: { analytics: ['read', 'query', 'write'] }, writeToolsExposed: true, compatibility: 'not_recorded' },
  neon: { serves: { database: ['read', 'query', 'write'] }, writeToolsExposed: true, compatibility: 'not_recorded' },
  supabase: { serves: { database: ['read', 'query', 'write'] }, writeToolsExposed: true, compatibility: 'not_recorded' },
  linear: { serves: { work_tracking: ['read', 'write'] }, writeToolsExposed: true, compatibility: 'not_recorded' },
  notion: { serves: { docs: ['read', 'write'] }, writeToolsExposed: true, compatibility: 'not_recorded' },
  context7: { serves: { docs: ['read'] }, writeToolsExposed: false, compatibility: 'not_recorded' },
};

/** Catalog category → domain, for entries with no profile (platform/team rows). */
const CATEGORY_DOMAIN: Record<ConnectorCatalogCategory, CapabilityDomain | null> = {
  deploy: 'deployment', database: 'database', observability: 'observability', project: 'work_tracking',
  docs: 'docs', analytics: 'analytics', other: null,
};

const OPERATOR_CAPABILITY: Partial<Record<`${CapabilityDomain}:${CapabilityVerb}`, string>> = {
  'deployment:read': 'deployments:read',
  'deployment:write': 'deployments:write',
};

// ── Input ────────────────────────────────────────────────────────────────────

export interface DiscoveryConnector {
  id: string;
  name: string;
  url: string;
  authMode: 'none' | 'header' | 'oauth' | 'assertion';
  transport: 'http' | 'stdio';
  command: string | null;
  ownerTeamId: string;
}

export interface DiscoveryCredential extends ConnectorCredentialSnapshot {
  healthStatus: 'healthy' | 'degraded' | 'revoked' | 'unknown' | string;
}

export interface DiscoveryRole { slug: string; connectorRefs: string[]; allowedTools: string[] }

export interface DiscoveryOperatorGrant { roleSlug: string; enabled: boolean; capabilities: string[]; providers: string[] }

export interface DiscoveryInput {
  /** The workspace's team. Connectors owned by another team are shared-in. */
  teamId: string;
  /** The team's merged catalog with its policies (loadTeamCatalog). */
  catalog: ResolvedCatalogEntry[];
  /** Connectors the team owns or has been shared. Nothing else may be passed. */
  connectors: DiscoveryConnector[];
  /** connector_workspaces rows of this workspace; no row = enabled at claim. */
  workspaceEnablement: Map<string, boolean>;
  /** mcp_connector_credential rows by connector id, owner-team keyed by the loader. */
  credentials: Map<string, DiscoveryCredential>;
  /** Effective role per slug in this workspace (workspace row over team row). */
  roles: DiscoveryRole[];
  /** The role to evaluate; null = any role of the team. */
  roleSlug: string | null;
  operatorGrant: DiscoveryOperatorGrant | null;
  now: Date;
}

// ── Output ───────────────────────────────────────────────────────────────────

export type CandidateAccess = 'permitted' | 'auto_grant' | 'ask_admin' | 'forbidden' | 'reconnect' | 'unhealthy';
export type CandidateHealth = 'ok' | 'not_connected' | 'expired' | 'needs_reconnect' | 'revoked' | 'degraded' | 'unchecked' | 'not_installed';

export interface CapabilityCandidate {
  provider: { slug: string | null; name: string; catalogPolicy: ResolvedCatalogEntry['policy'] | null };
  /** null = not installed for this team. */
  connector: { id: string; name: string; ownership: 'team' | 'shared'; transport: 'http' | 'stdio' } | null;
  match: 'exact' | 'partial' | 'category';
  matchNote?: string;
  access: CandidateAccess;
  /** permitted, healthy, and nothing known stops a run using it. */
  availableNow: boolean;
  reasons: string[];
  nextSteps: string[];
  workspace: 'enabled' | 'disabled' | 'default_enabled' | 'not_installed';
  health: CandidateHealth;
  roles: { evaluated: { slug: string; mounts: boolean } | null; withAccess: string[]; nativeToolsListed?: string[] };
  compatibility: { status: ProviderCompatibility; note?: string };
  risk: { requested: 'read' | 'write'; writeToolsExposed: boolean | 'unknown'; note: string };
  runtimeNeeds: { kind: 'binary'; name: string }[];
}

export interface CapabilityResolution {
  capability: string;
  role: { slug: string; found: boolean } | null;
  candidates: CapabilityCandidate[];
  /** The Operator's server-side deploy path, for deployment needs; null otherwise. */
  operator: { capability: string; role: string; granted: boolean; providers: string[] } | null;
  unclassifiedConnectors: { id: string; name: string }[];
  runtime: string;
  summary: string;
}

const RUNTIME_NOTE =
  'Runtime needs (browser, Docker, a CLI binary) are matched separately by the runner via task requiredCapabilities; '
  + 'a candidate lists only what its own connector needs to start.';

const ACCESS_RANK: Record<CandidateAccess, number> = {
  permitted: 0, auto_grant: 1, reconnect: 2, unhealthy: 3, ask_admin: 4, forbidden: 5,
};
const MATCH_RANK = { exact: 0, partial: 1, category: 2 } as const;

/** Whether `serves` covers `verb`: query implies read; write stands alone. */
function verbCovered(serves: CapabilityVerb[], verb: CapabilityVerb): 'exact' | 'partial' | null {
  if (serves.includes(verb)) return 'exact';
  if (verb === 'read' && serves.includes('query')) return 'exact';
  if (verb === 'query' && serves.includes('read')) return 'partial';
  return null;
}

function healthOf(c: DiscoveryConnector, cred: DiscoveryCredential | undefined, now: Date): CandidateHealth {
  if (c.transport === 'stdio') return 'unchecked';
  if (c.authMode === 'none') return 'ok';
  // Assertion connectors mint per run on the runner; nothing stored to read.
  if (c.authMode === 'assertion') return 'unchecked';
  if (!cred) return 'not_connected';
  if (cred.healthStatus === 'revoked') return 'revoked';
  if (needsReconnect(cred, now)) return 'needs_reconnect';
  if (deriveConnectorStatus(cred, now) === 'expired') return 'expired';
  if (cred.healthStatus === 'degraded') return 'degraded';
  return 'ok';
}

function serverKey(name: string): string {
  // Same rule as slugifyConnectorName (claim/mcp-connector-injection.ts), the key
  // the runner mounts the server under and that native tool names start with.
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || name.toLowerCase();
}

export function resolveCapability(input: DiscoveryInput, raw: string): CapabilityResolution | { error: string } {
  const parsed = parseCapability(raw);
  if (!parsed) {
    return { error: `Unknown capability "${raw}". Use domain:verb with domain one of ${CAPABILITY_DOMAINS.join(', ')} and verb one of ${CAPABILITY_VERBS.join(', ')} (e.g. observability:query).` };
  }
  const { domain, verb } = parsed;
  const capability = `${domain}:${verb}`;
  const requested: 'read' | 'write' = verb === 'write' ? 'write' : 'read';

  const roleBySlug = new Map(input.roles.map(r => [r.slug, r]));
  const evaluatedRole = input.roleSlug ? roleBySlug.get(input.roleSlug) ?? null : null;

  // Catalog entries by normalized URL, so an installed connector finds its provider.
  const entryByUrl = new Map<string, ResolvedCatalogEntry>();
  for (const e of input.catalog) {
    const k = normalizeConnectorUrl(e.url);
    if (k) entryByUrl.set(k, e);
  }

  function matchOf(entry: ResolvedCatalogEntry): { match: CapabilityCandidate['match']; profile: ProviderProfile | null } | null {
    const profile = PROVIDER_PROFILES[entry.slug] ?? null;
    if (profile) {
      const serves = profile.serves[domain];
      if (!serves) return null;
      const m = verbCovered(serves, verb);
      return m ? { match: m, profile } : null;
    }
    return CATEGORY_DOMAIN[entry.category] === domain ? { match: 'category', profile: null } : null;
  }

  function riskOf(profile: ProviderProfile | null): CapabilityCandidate['risk'] {
    const exposed = profile ? profile.writeToolsExposed : 'unknown';
    const note = requested === 'write'
      ? 'A write need: native write tools act on the provider account.'
      : exposed === true
        ? 'Mounting this connector exposes every native tool, writes included; a read need does not narrow it.'
        : exposed === false
          ? 'The provider lists read tools only.'
          : 'Not recorded whether this provider exposes write tools; treat as read/write.';
    return { requested, writeToolsExposed: exposed, note };
  }

  const candidates: CapabilityCandidate[] = [];
  const installedSlugs = new Set<string>();
  const unclassified: { id: string; name: string }[] = [];

  for (const c of input.connectors) {
    const urlKey = normalizeConnectorUrl(c.url);
    const entry = urlKey ? entryByUrl.get(urlKey) ?? null : null;
    if (!entry) { unclassified.push({ id: c.id, name: c.name }); continue; }
    installedSlugs.add(entry.slug);
    const m = matchOf(entry);
    if (!m) continue;

    const reasons: string[] = [];
    const nextSteps: string[] = [];
    const enabledRow = input.workspaceEnablement.get(c.id);
    const workspace: CapabilityCandidate['workspace'] = enabledRow === undefined ? 'default_enabled' : enabledRow ? 'enabled' : 'disabled';
    const health = healthOf(c, input.credentials.get(c.id), input.now);
    const withAccess = input.roles.filter(r => r.connectorRefs.includes(c.id)).map(r => r.slug).sort();
    const mounts = evaluatedRole ? evaluatedRole.connectorRefs.includes(c.id) : false;

    let access: CandidateAccess;
    if (entry.policy === 'blocked') {
      access = 'forbidden';
      reasons.push('catalog_blocked');
      nextSteps.push(`A team admin has blocked ${entry.name}; only they can unblock it.`);
    } else if (workspace === 'disabled') {
      access = 'ask_admin';
      reasons.push('disabled_in_workspace');
      nextSteps.push(`A team admin enables ${c.name} for this workspace.`);
    } else if (health === 'not_connected' || health === 'needs_reconnect' || health === 'revoked') {
      access = 'reconnect';
      reasons.push(health === 'not_connected' ? 'not_connected' : 'credential_dead');
      nextSteps.push(`Someone with the ${entry.name} account (re)connects ${c.name} on Settings → MCP connectors.`);
    } else if (health === 'degraded') {
      access = 'unhealthy';
      reasons.push('credential_degraded');
      nextSteps.push(`Recent ${entry.name} auth failures; check or reconnect ${c.name}.`);
    } else if (input.roleSlug) {
      if (mounts) access = 'permitted';
      else {
        reasons.push(evaluatedRole ? 'role_lacks_connector' : 'role_not_found');
        if (withAccess.length > 0) {
          access = 'auto_grant';
          nextSteps.push(`Route the task to ${withAccess.join(' or ')}, which already mounts ${c.name}; no admin action needed.`);
        } else {
          access = 'ask_admin';
          nextSteps.push(`A team admin adds ${c.name} to the ${input.roleSlug} role's connectors.`);
        }
      }
    } else if (withAccess.length > 0) {
      access = 'permitted';
    } else {
      access = 'ask_admin';
      reasons.push('no_role_mounts');
      nextSteps.push(`A team admin adds ${c.name} to a role's connectors.`);
    }

    const compat = m.profile?.compatibility ?? 'not_recorded';
    if (health === 'expired') reasons.push('token_refresh_pending');
    if (health === 'unchecked') reasons.push('health_unchecked');
    if (compat === 'unknown_until_tested') reasons.push('provider_compatibility_unknown');
    const availableNow = access === 'permitted' && health === 'ok' && compat !== 'unknown_until_tested';

    let nativeToolsListed: string[] | undefined;
    const role = evaluatedRole ?? null;
    if (role && role.allowedTools.length > 0) {
      const prefix = `mcp__${serverKey(c.name)}__`;
      const listed = role.allowedTools.filter(t => t.startsWith(prefix));
      if (listed.length > 0) nativeToolsListed = listed;
    }

    candidates.push({
      provider: { slug: entry.slug, name: entry.name, catalogPolicy: entry.policy },
      connector: { id: c.id, name: c.name, ownership: c.ownerTeamId === input.teamId ? 'team' : 'shared', transport: c.transport },
      match: m.match,
      ...(m.match === 'partial' && m.profile?.partialNote?.[domain] ? { matchNote: m.profile.partialNote[domain] } : {}),
      access,
      availableNow,
      reasons,
      nextSteps,
      workspace,
      health,
      roles: {
        evaluated: input.roleSlug ? { slug: input.roleSlug, mounts } : null,
        withAccess,
        ...(nativeToolsListed ? { nativeToolsListed } : {}),
      },
      compatibility: { status: compat, ...(m.profile?.compatibilityNote ? { note: m.profile.compatibilityNote } : {}) },
      risk: riskOf(m.profile),
      runtimeNeeds: c.transport === 'stdio' && c.command ? [{ kind: 'binary', name: c.command }] : [],
    });
  }

  // Catalog providers this team has not installed: alternatives an admin could add.
  for (const entry of input.catalog) {
    if (installedSlugs.has(entry.slug)) continue;
    const m = matchOf(entry);
    if (!m) continue;
    const blocked = entry.policy === 'blocked';
    const compat = m.profile?.compatibility ?? 'not_recorded';
    candidates.push({
      provider: { slug: entry.slug, name: entry.name, catalogPolicy: entry.policy },
      connector: null,
      match: m.match,
      ...(m.match === 'partial' && m.profile?.partialNote?.[domain] ? { matchNote: m.profile.partialNote[domain] } : {}),
      access: blocked ? 'forbidden' : 'ask_admin',
      availableNow: false,
      reasons: blocked ? ['catalog_blocked'] : ['not_installed'],
      nextSteps: blocked
        ? [`A team admin has blocked ${entry.name}; only they can unblock it.`]
        : [`A team admin adds ${entry.name} from the connector catalog, connects it, and adds it to a role.`],
      workspace: 'not_installed',
      health: 'not_installed',
      roles: { evaluated: input.roleSlug ? { slug: input.roleSlug, mounts: false } : null, withAccess: [] },
      compatibility: { status: compat, ...(m.profile?.compatibilityNote ? { note: m.profile.compatibilityNote } : {}) },
      risk: riskOf(m.profile),
      runtimeNeeds: [],
    });
  }

  candidates.sort((a, b) =>
    Number(b.availableNow) - Number(a.availableNow)
    || ACCESS_RANK[a.access] - ACCESS_RANK[b.access]
    || MATCH_RANK[a.match] - MATCH_RANK[b.match]
    || a.provider.name.localeCompare(b.provider.name));

  const opCap = OPERATOR_CAPABILITY[capability as keyof typeof OPERATOR_CAPABILITY];
  const g = input.operatorGrant;
  const operator = opCap && g && input.roleSlug && g.roleSlug === input.roleSlug
    ? { capability: opCap, role: g.roleSlug, granted: g.enabled && g.capabilities.includes(opCap), providers: g.providers }
    : null;

  return {
    capability,
    role: input.roleSlug ? { slug: input.roleSlug, found: !!evaluatedRole } : null,
    candidates,
    operator,
    unclassifiedConnectors: unclassified,
    runtime: RUNTIME_NOTE,
    summary: summarize(capability, candidates),
  };
}

function summarize(capability: string, candidates: CapabilityCandidate[]): string {
  if (candidates.length === 0) {
    return `Nothing installed or in this team's catalog serves ${capability}. A team admin can add a connector for it.`;
  }
  const now = candidates.filter(c => c.availableNow).map(c => c.provider.name);
  const rest = candidates.filter(c => !c.availableNow).map(c => `${c.provider.name} (${c.access})`);
  const parts: string[] = [];
  parts.push(now.length ? `available now: ${now.join(', ')}` : 'nothing available now');
  if (rest.length) parts.push(`otherwise: ${rest.join(', ')}`);
  return `${capability}: ${parts.join('; ')}.`;
}

export interface CapabilityListEntry { capability: string; candidates: number; availableNow: string[]; best: CandidateAccess }

/** Every vocabulary need something in this team serves, with what is usable now. */
export function listCapabilities(input: DiscoveryInput): { role: { slug: string; found: boolean } | null; capabilities: CapabilityListEntry[]; runtime: string } {
  const capabilities: CapabilityListEntry[] = [];
  for (const cap of CAPABILITY_VOCABULARY) {
    const r = resolveCapability(input, cap);
    if ('error' in r || r.candidates.length === 0) continue;
    capabilities.push({
      capability: cap,
      candidates: r.candidates.length,
      availableNow: r.candidates.filter(c => c.availableNow).map(c => c.provider.slug ?? c.provider.name),
      best: r.candidates[0].access,
    });
  }
  return {
    role: input.roleSlug ? { slug: input.roleSlug, found: input.roles.some(r => r.slug === input.roleSlug) } : null,
    capabilities,
    runtime: RUNTIME_NOTE,
  };
}
