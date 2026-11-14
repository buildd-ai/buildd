/**
 * The team's subscription-wall fallback, read and resolved server-side
 * (provider-failover spec, "Subscription wall fallback"; the policy is
 * packages/core/wall-fallback.ts).
 *
 * - `loadWallFallbackSetting`: the team's stored choice and daily cap.
 * - `resolveWallFallbackCredential`: the stored credential a choice would use
 *   for one workspace, as the claim delivers it (decrypted, server-side only)
 *   and as Settings describes it (label and last four characters, never the
 *   value).
 * - `wallFallbackSpentToday`: what the team's fallback runs cost since UTC
 *   midnight (`workers.wall_fallback` rows), the number the cap meters.
 * - `resolveTeamWallFallback`: all three at once, the one answer the claim,
 *   the worker report and Settings ask: would a walled run fall back now?
 *
 * Only credentials the team stored in `secrets`: the Anthropic API key, the
 * OpenRouter key, the LiteLLM gateway, the agent model endpoint. A
 * subscription login is never read here, because it is never stored.
 *
 * Never throws: an unreadable setting or credential answers "wait", the
 * behaviour a team had before this setting existed.
 */
import {
  OPENROUTER_AGENT_BASE_URL,
  resolveAgentEndpoint,
  resolveEndpointFromBlob,
  resolveEndpointRefs,
  resolveStoredAnthropicKey,
  type AgentEndpointBlob,
  type AgentEndpointRoute,
} from '@buildd/core/agent-endpoint';
import {
  DEFAULT_WALL_FALLBACK,
  fallbackCapReached,
  parseWallFallbackSetting,
  startOfUtcDay,
  type WallFallbackProvider,
  type WallFallbackSetting,
} from '@buildd/core/wall-fallback';

/** A fallback credential ready to deliver. The secret parts never leave the server except in a claim. */
export interface WallFallbackCredential {
  served: WallFallbackProvider;
  /** Plain words for the task page and Settings: "the team's Anthropic API key". */
  label: string;
  /** Last four characters of the key, for Settings. */
  last4: string | null;
  /** `anthropic`: the API key a run gets as ANTHROPIC_API_KEY. */
  apiKey?: string;
  /** Every other choice: the route the run gets as its model endpoint. */
  endpoint?: AgentEndpointRoute;
}

export const WALL_FALLBACK_LABELS: Record<WallFallbackProvider, string> = {
  anthropic: "the team's Anthropic API key",
  openrouter: "the team's OpenRouter key",
  litellm: "the team's LiteLLM gateway",
  endpoint: "the team's agent model endpoint",
};

function last4(value: string | null | undefined): string | null {
  const v = (value ?? '').trim();
  return v.length >= 8 ? v.slice(-4) : null;
}

export interface WallFallbackDeps {
  anthropicKey: (scope: { teamId: string; workspaceId: string | null }) => Promise<string | null>;
  /** A synthesized reference (OpenRouter / LiteLLM) resolved against what the team stored. */
  referenceRoute: (blob: AgentEndpointBlob, scope: { teamId: string; workspaceId: string | null }) => Promise<AgentEndpointRoute | null>;
  agentEndpoint: (scope: { teamId: string; workspaceId: string | null }) => Promise<AgentEndpointRoute | null>;
  loadSetting: (teamId: string) => Promise<unknown>;
  spentSince: (teamId: string, since: Date) => Promise<number>;
}

async function referenceRoute(blob: AgentEndpointBlob, scope: { teamId: string; workspaceId: string | null }): Promise<AgentEndpointRoute | null> {
  const refs = await resolveEndpointRefs(blob, scope);
  return resolveEndpointFromBlob(blob, refs.gateway, refs.openRouterKey, refs.cloudflare);
}

async function loadSettingRow(teamId: string): Promise<unknown> {
  const { db } = await import('@buildd/core/db');
  const { teams } = await import('@buildd/core/db/schema');
  const { eq } = await import('drizzle-orm');
  const { sqlWhere } = await import('@buildd/core/db/relational-sql');
  const row = await db.query.teams.findFirst({
    where: sqlWhere(eq(teams.id, teamId)),
    columns: { subscriptionWallFallback: true },
  });
  return row?.subscriptionWallFallback ?? null;
}

async function spentSinceRows(teamId: string, since: Date): Promise<number> {
  const { db } = await import('@buildd/core/db');
  const { workers, workspaces } = await import('@buildd/core/db/schema');
  const { and, eq, gte, isNotNull, sql } = await import('drizzle-orm');
  const rows = await db
    .select({ total: sql<string>`coalesce(sum(${workers.costUsd}), 0)` })
    .from(workers)
    .innerJoin(workspaces, eq(workers.workspaceId, workspaces.id))
    .where(and(eq(workspaces.teamId, teamId), isNotNull(workers.wallFallback), gte(workers.createdAt, since)));
  const n = parseFloat(String(rows?.[0]?.total ?? '0'));
  return Number.isFinite(n) ? n : 0;
}

const DEFAULT_DEPS: WallFallbackDeps = {
  anthropicKey: (scope) => resolveStoredAnthropicKey(scope),
  referenceRoute,
  agentEndpoint: (scope) => resolveAgentEndpoint(scope),
  loadSetting: loadSettingRow,
  spentSince: spentSinceRows,
};

export async function loadWallFallbackSetting(teamId: string | null | undefined, deps: WallFallbackDeps = DEFAULT_DEPS): Promise<WallFallbackSetting> {
  if (!teamId) return { ...DEFAULT_WALL_FALLBACK };
  try {
    return parseWallFallbackSetting(await deps.loadSetting(teamId));
  } catch (err) {
    console.warn(`[subscription-fallback] setting unreadable for team ${teamId}; waiting:`, err);
    return { ...DEFAULT_WALL_FALLBACK };
  }
}

/** The credential `served` would use for this workspace (null workspace: the team's own). Null when there is none. */
export async function resolveWallFallbackCredential(
  opts: { teamId: string; workspaceId: string | null; served: WallFallbackProvider },
  deps: WallFallbackDeps = DEFAULT_DEPS,
): Promise<WallFallbackCredential | null> {
  if (!process.env.ENCRYPTION_KEY) return null;
  const scope = { teamId: opts.teamId, workspaceId: opts.workspaceId };
  const label = WALL_FALLBACK_LABELS[opts.served];
  try {
    if (opts.served === 'anthropic') {
      const key = await deps.anthropicKey(scope);
      return key ? { served: 'anthropic', label, last4: last4(key), apiKey: key } : null;
    }
    let route: AgentEndpointRoute | null = null;
    if (opts.served === 'openrouter') {
      route = await deps.referenceRoute({ kind: 'openrouter', baseUrl: OPENROUTER_AGENT_BASE_URL, authHeader: 'authorization' }, scope);
    } else if (opts.served === 'litellm') {
      route = await deps.referenceRoute({ kind: 'gateway' }, scope);
    } else {
      route = await deps.agentEndpoint(scope);
    }
    return route ? { served: opts.served, label, last4: last4(route.apiKey), endpoint: route } : null;
  } catch (err) {
    console.warn(`[subscription-fallback] ${opts.served} lookup failed for team ${opts.teamId}:`, err);
    return null;
  }
}

export async function wallFallbackSpentToday(teamId: string, now: Date = new Date(), deps: WallFallbackDeps = DEFAULT_DEPS): Promise<number> {
  try {
    return await deps.spentSince(teamId, startOfUtcDay(now));
  } catch (err) {
    // Unreadable spend must not let a capped team spend without bound.
    console.warn(`[subscription-fallback] spend unreadable for team ${teamId}; treating the cap as reached:`, err);
    return Number.POSITIVE_INFINITY;
  }
}

export type TeamWallFallback =
  | { use: true; setting: WallFallbackSetting; credential: WallFallbackCredential; spentTodayUsd: number }
  | { use: false; setting: WallFallbackSetting; reason: 'wait' | 'no_credential' | 'cap_reached'; spentTodayUsd: number | null };

/**
 * Would a walled run of this workspace fall back right now? `wait` is the
 * team's choice; `no_credential` and `cap_reached` both mean the work waits.
 */
export async function resolveTeamWallFallback(
  opts: { teamId: string | null | undefined; workspaceId: string | null; now?: Date; setting?: WallFallbackSetting },
  deps: WallFallbackDeps = DEFAULT_DEPS,
): Promise<TeamWallFallback> {
  const setting = opts.setting ?? await loadWallFallbackSetting(opts.teamId, deps);
  if (!opts.teamId || setting.fallback === 'wait') return { use: false, setting, reason: 'wait', spentTodayUsd: null };
  const credential = await resolveWallFallbackCredential({ teamId: opts.teamId, workspaceId: opts.workspaceId, served: setting.fallback }, deps);
  if (!credential) return { use: false, setting, reason: 'no_credential', spentTodayUsd: null };
  const spentTodayUsd = setting.maxCostPerDayUsd === null ? 0 : await wallFallbackSpentToday(opts.teamId, opts.now, deps);
  if (fallbackCapReached(setting, spentTodayUsd)) return { use: false, setting, reason: 'cap_reached', spentTodayUsd };
  return { use: true, setting, credential, spentTodayUsd };
}

/**
 * Whether a team's fallback would serve a walled run now (credential stored,
 * daily cap not reached), cached a minute per team: the claim route asks it
 * on every answer to a subscription runner, empty polls included.
 */
const WALL_COVER_TTL_MS = 60_000;
const wallCoverCache = new Map<string, { at: number; covers: boolean }>();
export async function teamWallCover(teamId: string, deps: WallFallbackDeps = DEFAULT_DEPS): Promise<boolean> {
  const hit = wallCoverCache.get(teamId);
  if (hit && Date.now() - hit.at < WALL_COVER_TTL_MS) return hit.covers;
  const covers = (await resolveTeamWallFallback({ teamId, workspaceId: null }, deps)).use;
  wallCoverCache.set(teamId, { at: Date.now(), covers });
  return covers;
}
