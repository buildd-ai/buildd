/**
 * What a team does when a runner's subscription login hits a usage wall
 * (provider-failover spec, "Subscription wall fallback").
 *
 * The default is to wait for the reset (spec "A usage wall is a wait"). A team
 * admin may instead name a credential the team stored in `secrets` for a run
 * to fall back to: the team's Anthropic API key, its stored OpenRouter key,
 * its LiteLLM gateway, or its agent model endpoint. An optional daily cap
 * bounds what fallback runs spend; once it is reached the work waits again.
 *
 * Only a runner whose account is `authType: 'oauth'` (it runs on its own
 * machine's subscription login) falls back. The subscription login never
 * leaves that machine: buildd only ever delivers the team's own stored
 * credential, and only for the run that met the wall.
 *
 * Naming a fallback reserves that credential for walls: a subscription
 * runner's ordinary runs no longer receive it (`heldForWall`), so they spend
 * the login first. An `api` runner is unaffected and keeps every credential.
 *
 * Pure: no db, no env.
 */

export const WALL_FALLBACK_CHOICES = ['wait', 'anthropic', 'openrouter', 'litellm', 'endpoint'] as const;
export type WallFallbackChoice = typeof WALL_FALLBACK_CHOICES[number];
/** A choice that actually serves a run: everything but `wait`. */
export type WallFallbackProvider = Exclude<WallFallbackChoice, 'wait'>;

export interface WallFallbackSetting {
  fallback: WallFallbackChoice;
  /** USD a team's fallback runs may spend per UTC day. null = no cap. */
  maxCostPerDayUsd: number | null;
}

export const DEFAULT_WALL_FALLBACK: WallFallbackSetting = { fallback: 'wait', maxCostPerDayUsd: null };

/** Highest cap the setting accepts; far above any real day. */
export const MAX_WALL_FALLBACK_CAP_USD = 1_000_000;

/** Task context: this task never falls back; it waits for its own login. */
export const SUBSCRIPTION_PINNED_KEY = 'subscriptionPinned' as const;
/** Task context: the latest fallback run of this task (`WallFallbackRecord`). */
export const WALL_FALLBACK_CONTEXT_KEY = 'wallFallback' as const;

/** The claim response's advertisement: a walled login of this account may keep claiming these. */
export interface WallFallbackCover {
  claude?: boolean;
}

/** What the claim wrote on the task and the worker for a fallback run. */
export interface WallFallbackRecord {
  served: WallFallbackProvider;
  /** Plain-words name of the credential, e.g. "the team's Anthropic API key". */
  label: string;
  /** Whose login hit the wall: one runner's login, or the account's pool. */
  wall: { scope: 'login' | 'pool'; runner: string | null; resetsAt?: string | null };
  at: string;
}

function isChoice(v: unknown): v is WallFallbackChoice {
  return typeof v === 'string' && (WALL_FALLBACK_CHOICES as readonly string[]).includes(v);
}

/** The stored column, read leniently: anything unreadable is the default. */
export function parseWallFallbackSetting(raw: unknown): WallFallbackSetting {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...DEFAULT_WALL_FALLBACK };
  const r = raw as Record<string, unknown>;
  if (!isChoice(r.fallback)) return { ...DEFAULT_WALL_FALLBACK };
  const cap = typeof r.maxCostPerDayUsd === 'number' && Number.isFinite(r.maxCostPerDayUsd) && r.maxCostPerDayUsd > 0
    ? r.maxCostPerDayUsd
    : null;
  return { fallback: r.fallback, maxCostPerDayUsd: cap };
}

/** A save, read strictly. Whether the credential exists is the route's check, not this one. */
export function validateWallFallbackInput(input: unknown):
  | { ok: true; setting: WallFallbackSetting }
  | { ok: false; error: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Send { fallback, maxCostPerDayUsd? }.' };
  const r = input as Record<string, unknown>;
  if (!isChoice(r.fallback)) return { ok: false, error: `fallback must be one of: ${WALL_FALLBACK_CHOICES.join(', ')}.` };
  let cap: number | null = null;
  if (r.maxCostPerDayUsd !== undefined && r.maxCostPerDayUsd !== null) {
    if (typeof r.maxCostPerDayUsd !== 'number' || !Number.isFinite(r.maxCostPerDayUsd) || r.maxCostPerDayUsd <= 0) {
      return { ok: false, error: 'The daily cap must be a dollar amount above zero, or empty for no cap.' };
    }
    if (r.maxCostPerDayUsd > MAX_WALL_FALLBACK_CAP_USD) return { ok: false, error: `The daily cap must be at most $${MAX_WALL_FALLBACK_CAP_USD.toLocaleString('en-US')}.` };
    cap = Math.round(r.maxCostPerDayUsd * 100) / 100;
  }
  return { ok: true, setting: { fallback: r.fallback, maxCostPerDayUsd: cap } };
}

/** The model route a fallback run is set up with (`workers.model_route`). */
export function wallFallbackRoute(served: WallFallbackProvider): 'anthropic_api_key' | 'agent_endpoint' {
  return served === 'anthropic' ? 'anthropic_api_key' : 'agent_endpoint';
}

/**
 * Which credential a subscription runner's ordinary run must NOT receive,
 * because the team reserved it for walls. OpenRouter and LiteLLM reach an
 * agent run only through an agent endpoint row, so naming them reserves
 * nothing. An `api` account is never affected.
 */
export function heldForWall(
  setting: WallFallbackSetting,
  authType: string | null | undefined,
): 'anthropic_api_key' | 'agent_endpoint' | null {
  if (authType !== 'oauth') return null;
  if (setting.fallback === 'anthropic') return 'anthropic_api_key';
  if (setting.fallback === 'endpoint') return 'agent_endpoint';
  return null;
}

export function fallbackCapReached(setting: WallFallbackSetting, spentTodayUsd: number): boolean {
  return setting.maxCostPerDayUsd !== null && spentTodayUsd >= setting.maxCostPerDayUsd;
}

export function isSubscriptionPinned(context: unknown): boolean {
  return !!context && typeof context === 'object'
    && (context as Record<string, unknown>)[SUBSCRIPTION_PINNED_KEY] === true;
}

/** The fallback cap's day: it resets at UTC midnight. */
export function startOfUtcDay(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

export function parseWallFallbackRecord(raw: unknown): WallFallbackRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isChoice(r.served) || r.served === 'wait' || typeof r.label !== 'string') return null;
  const wall = (r.wall && typeof r.wall === 'object' ? r.wall : {}) as Record<string, unknown>;
  return {
    served: r.served,
    label: r.label,
    wall: {
      scope: wall.scope === 'login' ? 'login' : 'pool',
      runner: typeof wall.runner === 'string' ? wall.runner : null,
      ...(typeof wall.resetsAt === 'string' ? { resetsAt: wall.resetsAt } : {}),
    },
    at: typeof r.at === 'string' ? r.at : '',
  };
}

/**
 * The one sentence every surface shows for a fallback run: what served it,
 * whose login hit the wall, and what it cost.
 */
export function describeWallFallback(raw: unknown, costUsd: number | null | undefined): string | null {
  const rec = parseWallFallbackRecord(raw);
  if (!rec) return null;
  const who = rec.wall.scope === 'login' && rec.wall.runner ? `${rec.wall.runner}'s` : "the runner account's";
  const cost = typeof costUsd === 'number' && Number.isFinite(costUsd) ? ` Cost $${costUsd.toFixed(2)}.` : '';
  return `Ran on ${rec.label}: ${who} subscription login hit its usage limit.${cost}`;
}
