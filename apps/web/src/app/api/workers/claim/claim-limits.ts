import type { AgentBackend, ClaimAccountLimitCode, ClaimBudgetWall } from '@buildd/shared';

/**
 * Words for a claim that a limit refused: which limit, and when it lifts.
 *
 * A refusal used to say only `budget_exhausted` or "Max concurrent workers
 * limit reached", which could not tell the account's own session limit from a
 * rate limit a run recorded for the team, nor say when to come back (task
 * e7e8740a, split from #4191 without its bypass).
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const pad = (n: number) => String(n).padStart(2, '0');

/** "20:00 UTC" today, "Oct 10, 09:00 UTC" on another day; null when unknown. */
export function formatLiftTime(at: Date | string | null | undefined, now: Date = new Date()): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const time = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} UTC`;
  const sameDay = d.getUTCFullYear() === now.getUTCFullYear()
    && d.getUTCMonth() === now.getUTCMonth()
    && d.getUTCDate() === now.getUTCDate();
  return sameDay ? time : `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${time}`;
}

/** ISO string for a usable time, else null. */
export function isoOrNull(at: Date | string | null | undefined): string | null {
  if (!at) return null;
  const d = at instanceof Date ? at : new Date(at);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/** The walls one claim request held a task on, one per kind and provider. */
export class BudgetWalls {
  private readonly walls = new Map<string, ClaimBudgetWall>();

  add(kind: ClaimBudgetWall['kind'], backend: AgentBackend, resetsAt: Date | string | null | undefined): void {
    const key = `${kind}:${backend}`;
    if (this.walls.has(key)) return;
    this.walls.set(key, { kind, backend, resetsAt: isoOrNull(resetsAt) });
  }

  get size(): number {
    return this.walls.size;
  }

  list(): ClaimBudgetWall[] {
    return [...this.walls.values()];
  }
}

const providerName = (b: AgentBackend) => (b === 'codex' ? 'Codex' : 'Claude');

/** One sentence for one wall. */
export function describeBudgetWall(wall: ClaimBudgetWall, now: Date = new Date()): string {
  const name = providerName(wall.backend);
  const at = formatLiftTime(wall.resetsAt, now);
  switch (wall.kind) {
    case 'account_seat':
      return `The account's ${name} session limit is reached.${at ? ` It lifts at ${at}.` : ''}`;
    case 'provider_pause':
      return `A run hit the ${name} rate limit for this team.${at ? ` ${name} work waits until ${at}.` : ` ${name} work waits until it clears.`}`;
    case 'tenant_budget':
      return `This tenant's ${name} budget is used up${at ? ` until ${at}` : ''}.`;
  }
}

/**
 * The walls as a person reads them. A verified interactive session is not held
 * by the account seat or a recorded rate limit (#4211), so a runner caller is
 * told that; a session caller is not told about its own exemption.
 */
export function describeBudgetWalls(walls: ClaimBudgetWall[], opts: { now?: Date; interactive: boolean }): string {
  const now = opts.now ?? new Date();
  const lines = walls.map(w => describeBudgetWall(w, now));
  if (!opts.interactive && walls.some(w => w.kind === 'account_seat' || w.kind === 'provider_pause')) {
    lines.push('A claim from your own Claude Code session runs on your seat and can start now.');
  }
  return lines.join(' ');
}

type Num = number | string | null | undefined;
const usd = (v: Num) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? `$${n.toFixed(2)}` : '$?';
};

/**
 * Body for an account-level 429. `error` keeps its old string (runners and
 * integration tests match on it); `code` and `detail` say which limit and
 * what lifts it.
 */
export function accountLimitRefusal(opts: { code: ClaimAccountLimitCode; limit: Num; current: Num }) {
  const { code, limit, current } = opts;
  switch (code) {
    case 'max_concurrent_workers':
      return {
        error: 'Max concurrent workers limit reached', code, limit, current,
        detail: `All ${limit} runner slots on this account are busy. A slot frees when a running task finishes.`,
      };
    case 'daily_cost_limit':
      return {
        error: 'Daily cost limit exceeded', code, limit, current,
        detail: `The account has spent ${usd(current)} of its ${usd(limit)} daily limit. Raise the limit in Settings to start more work today.`,
      };
    case 'max_concurrent_sessions':
      return {
        error: 'Max concurrent sessions limit reached', code, limit, current,
        detail: `The account is at its limit of ${limit} concurrent sessions. One frees when a session ends.`,
      };
  }
}
