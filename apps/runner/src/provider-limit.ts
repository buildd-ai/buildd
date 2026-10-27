/**
 * The provider's own word about this runner's login limit (spec 0dc7c6de R-18, R-19).
 *
 * A `rate_limit` event from the SDK carries `rate_limit_info`: `status`
 * (`allowed`, `allowed_warning`, `rejected`), `rateLimitType` and `resetsAt`.
 * On a warning or a rejection the runner starts no new work on that provider
 * until `resetsAt`; running sessions finish. Each provider is held alone.
 *
 * Nothing here estimates, learns or stores capacity, a usage curve or a history
 * of episodes: the only state is "provider X holds until T", in memory, and it
 * lapses by itself. A warning that names no reset time holds nothing, because
 * "until when" would be a guess.
 */

export type LimitProvider = 'claude' | 'codex';

export interface ProviderLimit {
  provider: LimitProvider;
  /** `warning` = the provider warned; `rejected` = it refused the request. */
  status: 'warning' | 'rejected';
  /** The provider's own limit type (`five_hour`, `seven_day`, ...), or `unknown`. */
  kind: string;
  untilMs: number;
}

/** What the claim carries so the server holds this runner's claims on the provider. */
export interface ReportedLimitWall {
  provider: LimitProvider;
  status: 'warning' | 'rejected';
  kind: string;
  resetsAt: string;
}

/** A `rejected` event that quotes no reset: hold briefly, then try again. */
const REJECTED_NO_RESET_MS = 5 * 60 * 1000;
/** Longest hold taken from a provider's reset time. */
const MAX_HOLD_MS = 7 * 24 * 60 * 60 * 1000;

/** `resetsAt` is a unix time; Claude Code sends seconds, accept milliseconds too. */
function resetMsOf(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) return null;
  return v < 1e12 ? v * 1000 : v;
}

/** The limit a `rate_limit` system event reports, or null when it holds nothing back. */
export function limitFromEvent(event: any, provider: LimitProvider, now: number): ProviderLimit | null {
  const info = event?.rate_limit_info;
  if (!info) return null;
  const status = info.status;
  if (status !== 'allowed_warning' && status !== 'rejected') return null;
  const kind = typeof info.rateLimitType === 'string' && info.rateLimitType ? info.rateLimitType : 'unknown';
  const reset = resetMsOf(info.resetsAt);
  if (reset !== null && reset > now) {
    return { provider, status: status === 'rejected' ? 'rejected' : 'warning', kind, untilMs: Math.min(reset, now + MAX_HOLD_MS) };
  }
  if (status === 'rejected') return { provider, status: 'rejected', kind, untilMs: now + REJECTED_NO_RESET_MS };
  return null;
}

/** Providers held from starting new work, each to its reset time. Memory only. */
export class ProviderLimitHolds {
  private held = new Map<LimitProvider, ProviderLimit>();

  /** Hold `limit.provider`; never shortens a longer hold, and a rejection keeps its status. */
  hold(limit: ProviderLimit): void {
    const prev = this.held.get(limit.provider);
    if (!prev) { this.held.set(limit.provider, limit); return; }
    const status = prev.status === 'rejected' || limit.status === 'rejected' ? 'rejected' : 'warning';
    const longer = limit.untilMs >= prev.untilMs ? limit : prev;
    this.held.set(limit.provider, { ...longer, status });
  }

  private live(provider: LimitProvider, now: number): ProviderLimit | null {
    const l = this.held.get(provider);
    if (!l) return null;
    if (now >= l.untilMs) { this.held.delete(provider); return null; }
    return l;
  }

  /** When `provider` is held until (ms), or null. */
  heldUntil(provider: LimitProvider, now: number = Date.now()): number | null {
    return this.live(provider, now)?.untilMs ?? null;
  }

  isHeld(provider: LimitProvider, now: number = Date.now()): boolean {
    return this.live(provider, now) !== null;
  }

  /** Live holds, the soonest to lift first. */
  list(now: number = Date.now()): ProviderLimit[] {
    return (['claude', 'codex'] as const)
      .map(p => this.live(p, now))
      .filter((l): l is ProviderLimit => l !== null)
      .sort((a, b) => a.untilMs - b.untilMs);
  }

  /** Every provider a runner can start work on is held; `startable` names those (default: both). */
  allHeld(now: number = Date.now(), startable: readonly LimitProvider[] = ['claude', 'codex']): boolean {
    return startable.length > 0 && startable.every(p => this.isHeld(p, now));
  }

  /** The soonest lift among live holds, or null. */
  nextLift(now: number = Date.now()): number | null {
    return this.list(now)[0]?.untilMs ?? null;
  }

  /** The holds as a claim reports them. */
  report(now: number = Date.now()): ReportedLimitWall[] {
    return this.list(now).map(l => ({ provider: l.provider, status: l.status, kind: l.kind, resetsAt: new Date(l.untilMs).toISOString() }));
  }
}

export function providerOfBackend(backend: string | null | undefined): LimitProvider {
  return backend === 'codex' ? 'codex' : 'claude';
}
