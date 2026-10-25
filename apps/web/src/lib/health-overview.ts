// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.

/**
 * Health → Overview, as plain data: the one status sentence at the top, and the
 * short status rows (runners, budget) that link to Runners &
 * capacity. Pure, so the wording is tested without a DOM.
 *
 * Written for a team using buildd, not for buildd's developers: counts a person
 * can act on, in plain words, and nothing that only means something inside
 * buildd.
 */

/** Things that need someone. Each failure group counts once, however many workers it hit. */
export interface OverviewAttention {
  noRunners: boolean;
  offlineRunners: number;
  unsandboxedRunners: number;
  brokenCredentials: number;
  strandedBackends: number;
  failingSchedules: number;
  failureGroups: number;
  /** Runs that could not get the access they need, by workspace and cause. */
  accessProblems?: number;
}

export interface OverviewState {
  /** Runners seen recently (`isRunnerRecentlySeen`): a long-gone runner is not counted. */
  runners: { total: number; online: number; busySlots: number };
  budget: {
    monthly: { spentUsd: number; budgetUsd: number; pctUsed: number } | null;
    /** Providers currently refusing work until a limit resets; `resetsInMs` null when unknown. */
    paused: Array<{ label: string; resetsInMs: number | null }>;
  };
}

export type OverviewTone = 'ok' | 'warning' | 'error' | 'muted';

export interface OverviewStatusRow {
  key: 'runners' | 'budget';
  label: string;
  value: string;
  tone: OverviewTone;
  href: string;
}

const RUNNERS_HREF = '/app/health/runners';
const BUDGETS_HREF = '/app/settings/billing';

export function attentionCount(a: OverviewAttention): number {
  return (a.noRunners ? 1 : 0) + a.offlineRunners + a.unsandboxedRunners + a.brokenCredentials
    + a.strandedBackends + a.failingSchedules + a.failureGroups + (a.accessProblems ?? 0);
}

export function overviewHeadline(a: OverviewAttention): { tone: 'ok' | 'attention'; count: number; text: string } {
  const count = attentionCount(a);
  if (count === 0) return { tone: 'ok', count, text: 'All good.' };
  const fact = (n: number, label: string) => n ? `${n} ${label}${n === 1 ? '' : 's'}` : null;
  const facts = [
    a.noRunners ? 'No runners connected' : null,
    fact(a.offlineRunners, 'offline runner'), fact(a.unsandboxedRunners, 'sandbox problem'),
    fact(a.brokenCredentials, 'broken credential'), fact(a.strandedBackends, 'backend without a credential'),
    fact(a.failingSchedules, 'failing schedule'), fact(a.accessProblems ?? 0, 'access problem'),
    fact(a.failureGroups, 'failure cause'),
  ].filter(Boolean);
  return { tone: 'attention', count, text: `${facts.join(' · ')}.` };
}

function resetsIn(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** "Codex paused · resets in 7h": which provider stopped, and when it starts again. */
function pausedValue(paused: OverviewState['budget']['paused']): string {
  const names = paused.map(p => p.label);
  const who = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
  const known = paused.map(p => p.resetsInMs).filter((ms): ms is number => ms !== null);
  return known.length ? `${who} paused · resets in ${resetsIn(Math.min(...known))}` : `${who} paused`;
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function overviewStatusRows(
  s: OverviewState,
  opts?: { hideOfflineRunners?: boolean },
): OverviewStatusRow[] {
  const { runners, budget } = s;

  const runnerRow: OverviewStatusRow | null = runners.total === 0
    ? { key: 'runners', label: 'Runners', value: 'None connected', tone: 'error', href: RUNNERS_HREF }
    : runners.online === 0 && opts?.hideOfflineRunners
      ? null
      : runners.online === 0
        ? { key: 'runners', label: 'Runners', value: 'None online', tone: 'error', href: RUNNERS_HREF }
        : {
            key: 'runners',
            label: 'Runners',
            value: `${runners.online} online · ${runners.busySlots} running`,
            tone: runners.online === runners.total ? 'ok' : 'warning',
            href: RUNNERS_HREF,
          };

  const budgetRow: OverviewStatusRow = budget.paused.length > 0
    ? { key: 'budget', label: 'Budget', value: pausedValue(budget.paused), tone: 'warning', href: RUNNERS_HREF }
    : budget.monthly
      ? {
          key: 'budget',
          label: 'Budget',
          value: `${usd(budget.monthly.spentUsd)} of ${usd(budget.monthly.budgetUsd)} this month${budget.monthly.spentUsd > budget.monthly.budgetUsd ? ' · Over budget' : ''}`,
          tone: budget.monthly.pctUsed >= 90 ? 'error' : budget.monthly.pctUsed >= 70 ? 'warning' : 'ok',
          href: BUDGETS_HREF,
        }
      : { key: 'budget', label: 'Budget', value: 'No monthly limit set', tone: 'muted', href: BUDGETS_HREF };

  return [runnerRow, budgetRow].filter((row): row is OverviewStatusRow => row !== null);
}
