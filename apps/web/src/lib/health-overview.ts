import { needsYouHeadline } from './home-needs-you';

/**
 * Health → Overview, as plain data: the one status sentence at the top, and the
 * short status rows (runners, credentials, budget) that link to Runners &
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
  runners: { total: number; online: number; busySlots: number; slots: number };
  credentials: { total: number; broken: number };
  budget: {
    monthly: { spentUsd: number; budgetUsd: number; pctUsed: number } | null;
    /** Providers currently refusing work until a limit resets. */
    pausedProviders: number;
  };
}

export type OverviewTone = 'ok' | 'warning' | 'error' | 'muted';

export interface OverviewStatusRow {
  key: 'runners' | 'credentials' | 'budget';
  label: string;
  value: string;
  tone: OverviewTone;
  href: string;
}

const RUNNERS_HREF = '/app/health/runners';

export function attentionCount(a: OverviewAttention): number {
  return (a.noRunners ? 1 : 0) + a.offlineRunners + a.unsandboxedRunners + a.brokenCredentials
    + a.strandedBackends + a.failingSchedules + a.failureGroups + (a.accessProblems ?? 0);
}

export function overviewHeadline(a: OverviewAttention): { tone: 'ok' | 'attention'; count: number; text: string } {
  const count = attentionCount(a);
  if (count === 0) return { tone: 'ok', count, text: 'All good.' };
  return { tone: 'attention', count, text: needsYouHeadline(count) };
}

function usd(n: number): string {
  return `$${Math.round(n).toLocaleString('en-US')}`;
}

export function overviewStatusRows(s: OverviewState): OverviewStatusRow[] {
  const { runners, credentials, budget } = s;

  const runnerRow: OverviewStatusRow = runners.total === 0
    ? { key: 'runners', label: 'Runners', value: 'None connected', tone: 'error', href: RUNNERS_HREF }
    : runners.online === 0
      ? { key: 'runners', label: 'Runners', value: 'None online', tone: 'error', href: RUNNERS_HREF }
      : {
          key: 'runners',
          label: 'Runners',
          value: `${runners.online} of ${runners.total} online · ${runners.busySlots} of ${runners.slots} agents running`,
          tone: runners.online === runners.total ? 'ok' : 'warning',
          href: RUNNERS_HREF,
        };

  const credentialRow: OverviewStatusRow = credentials.total === 0
    // No stored credential is normal when runners use their own sign-in: neutral, not a warning.
    ? { key: 'credentials', label: 'Credentials', value: 'None stored', tone: 'muted', href: RUNNERS_HREF }
    : credentials.broken > 0
      ? {
          key: 'credentials',
          label: 'Credentials',
          value: credentials.broken === 1 ? '1 needs attention' : `${credentials.broken} need attention`,
          tone: 'error',
          href: RUNNERS_HREF,
        }
      : { key: 'credentials', label: 'Credentials', value: `${credentials.total} working`, tone: 'ok', href: RUNNERS_HREF };

  const budgetRow: OverviewStatusRow = budget.pausedProviders > 0
    ? { key: 'budget', label: 'Budget', value: 'Paused until a usage limit resets', tone: 'warning', href: RUNNERS_HREF }
    : budget.monthly
      ? {
          key: 'budget',
          label: 'Budget',
          value: `${usd(budget.monthly.spentUsd)} of ${usd(budget.monthly.budgetUsd)} this month`,
          tone: budget.monthly.pctUsed >= 90 ? 'error' : budget.monthly.pctUsed >= 70 ? 'warning' : 'ok',
          href: RUNNERS_HREF,
        }
      : { key: 'budget', label: 'Budget', value: 'No monthly limit set', tone: 'muted', href: RUNNERS_HREF };

  return [runnerRow, credentialRow, budgetRow];
}
