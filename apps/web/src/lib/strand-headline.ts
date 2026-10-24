// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.

/**
 * The headline Health prints over a stranded-backend row (spec 97b1bd0b R-10).
 *
 * "Blocked" is the claim scheduler's verdict, so it is only said when a sampled
 * task carries a fresh recorded refusal for a missing credential. A
 * configured-credential lookup alone, or a stale/unknown decision, yields an
 * unconfirmed headline that says what is and is not known.
 *
 * Pure and DB-free: imported by a client component.
 */
import type { ClaimBlocker } from './claim-blocker-projection';
import { isRunnerOnline, type RunnerHeartbeat } from './runner-heartbeats-shared';

interface StrandRowLike {
  label: string;
  strandedPending: number;
  /** The team's mask allows this backend; turning it off reroutes unpinned work. */
  enabledForTeam?: boolean;
  sampleTasks: ReadonlyArray<{
    claim?: Pick<ClaimBlocker, 'state' | 'kind'>;
    /** `pinned`: the task was assigned this backend outright and never fails over. */
    route?: { pinned?: boolean };
  }>;
}

export interface StrandHeadline {
  /** The scheduler has recently refused work on this backend for a credential. */
  confirmed: boolean;
  title: string;
  tag: string;
  detail: string;
}

/** Model sign-ins and keys live on Models, not Runners. */
export const STRAND_FIX = { href: '/app/settings/models', label: 'Connect in Models' } as const;

const tasksWord = (n: number) => `${n} task${n === 1 ? '' : 's'}`;

export function strandHeadline(row: StrandRowLike): StrandHeadline {
  const n = row.strandedPending;
  const claims = row.sampleTasks.map((t) => t.claim);
  const confirmed = claims.some((c) => c?.state === 'blocked' && c.kind === 'credential_unavailable');
  const pinned = row.sampleTasks.some((t) => t.route?.pinned);
  const label = row.label;
  // A pinned task waits for its own backend, so rerouting is not offered for it.
  const fix = !pinned && row.enabledForTeam !== false
    ? `Sign in to ${label} on a runner, add a key in Models, or turn ${label} off to reroute.`
    : `Sign in to ${label} on a runner or add a key in Models.`;
  const unconfirmed = confirmed ? ''
    : claims.some((c) => c?.state === 'stale') ? ' Last scheduler check is stale.'
    : ' Not confirmed by the scheduler.';
  return {
    confirmed,
    title: `No ${label} sign-in`,
    tag: `${tasksWord(n)} ${confirmed ? 'blocked' : 'waiting'}`,
    detail: `${pinned ? `Pinned to ${label}. ` : ''}${fix}${unconfirmed}`,
  };
}

/**
 * Drop Codex from the stranded rows when an online runner reports its own Codex
 * login: the claim route runs Codex work on that login (runnerHasLocalCodexAuth),
 * though no credential is stored for the team. Health would otherwise call a
 * working backend credential-less.
 */
export function withoutRunnerServedStrands<T extends { backend: string }>(
  strands: readonly T[],
  runners: ReadonlyArray<Pick<RunnerHeartbeat, 'lastHeartbeatAt' | 'codexAuthSource'>>,
  now: number,
): T[] {
  const codexLogin = runners.some((r) =>
    (r.codexAuthSource === 'machine_login' || r.codexAuthSource === 'api_key') && isRunnerOnline(r.lastHeartbeatAt, now));
  return codexLogin ? strands.filter((s) => s.backend !== 'codex') : [...strands];
}
