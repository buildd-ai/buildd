/**
 * Pure, dependency-free runner-heartbeat helpers and types.
 *
 * This module MUST NOT import the DB (or anything that transitively pulls in
 * `@buildd/core/db` → `packages/core/config.ts` → `dotenv.config()`), because
 * it is imported by client components (e.g. HealthClient). `dotenv.config()`
 * reads `process.stdout.isTTY`, which is undefined in the browser and throws
 * `Cannot read properties of undefined (reading 'isTTY')` during module
 * evaluation — taking down the whole client bundle and every page that ships
 * it. Keep DB access in `runner-heartbeats.ts`. (`@buildd/shared` is fine: it
 * is DB-free and already bundled into client components.)
 */
import type { RunnerClass } from './runner-ownership';

import {
  RUNNER_LIVE_WINDOW_MS,
  RUNNER_ONLINE_THRESHOLD_MS,
  isIsolationRecordCurrent,
  isolationVerdict,
  type RunnerCodexAuthSource,
  type RunnerIsolationRecord,
  type RunnerModelAuthSource,
} from '@buildd/shared';

export interface RunnerHeartbeat {
  id: string;
  accountId: string;
  accountName: string | null;
  lastHeartbeatAt: string;
  activeWorkerCount: number;
  maxConcurrentWorkers: number;
  /** How the runner connects: push_only = no inbound HTTP (headless/NAT), reachable = has inbound HTTP server. */
  connectivity: 'reachable' | 'push_only';
  /**
   * Whether the host's bwrap namespace probe passed. null = probe not yet run.
   * This is a CAPABILITY, not a posture: true means bwrap works here, not that
   * anything is confined. See deriveSandboxPosture.
   */
  sandboxEnabled: boolean | null;
  /** ISO timestamp of the last bwrap probe, or null if not yet probed. */
  sandboxProbeAt: string | null;
  /**
   * Whether the runner reports the `sandbox:mount-allowlist` capability, i.e. the
   * mount allowlist is opted in AND the namespace it needs is available. This is
   * the only signal that isolation is actually being enforced.
   */
  mountAllowlistEnforced: boolean;
  /**
   * The confinement per backend and mode, with the cause when there is none
   * (heartbeat `environment.isolation`). Null on runner builds that predate
   * it: then only `sandboxEnabled` is known, and its cause is not.
   */
  isolation: RunnerIsolationRecord | null;
  /**
   * Other people's tasks can run here: the runner's team or the team viewing
   * it has more than one member. An operator's opt-out is allowed only when
   * this is false (runner-isolation-health.ts).
   */
  shared: boolean;
  /**
   * Pending tasks in the viewed workspaces this runner's claim would refuse
   * for isolation, by requirement (runner-isolation-health isolationBlockedCounts).
   * Set by Health's loader; absent elsewhere.
   */
  isolationBlocked?: { protected: number; trustedLocal: number };
  /**
   * The viewing user created this runner's account: they manage it. False
   * for a teammate's runner (or one with no recorded creator), which the
   * Health page lists apart under "Team runners".
   */
  mine: boolean;
  /**
   * The model login the runner itself reported on its last heartbeat (a label,
   * never a credential). Null/absent: an older runner that sends none, which
   * is not the same as `none`.
   */
  modelAuthSource?: RunnerModelAuthSource | null;
  codexAuthSource?: RunnerCodexAuthSource | null;
  /** Authoritative ownership (managed / team host / personal / unknown); see runner-ownership.ts. */
  runnerClass?: RunnerClass;
  /** How the runner's model usage is paid: `oauth` = the login on its own machine, `api` = a key. Absent when unknown. */
  authType?: 'oauth' | 'api';
  /**
   * The slots a team owner or admin set (or the runner last reported) and
   * where that came from (worker_heartbeats.desired_slots*); `canEdit` is
   * whether the viewer may change it (spec 34a48877 R-23). Absent where a
   * loader does not fill it.
   */
  slots?: {
    desired: number | null;
    origin: 'dashboard' | 'machine' | null;
    setBy: string | null;
    setAt: string | null;
    canEdit: boolean;
  };
}

/** Capability string the runner advertises when mount isolation is enforced. */
const CAPABILITY_MOUNT_ALLOWLIST = 'sandbox:mount-allowlist';

/**
 * Read the mount-allowlist capability out of a heartbeat's reported environment.
 *
 * The capability has existed in the heartbeat payload since the mount-allowlist
 * rollout and had no reader here, which is why the page could only show kernel
 * capability. Duplicated as a literal rather than imported from @buildd/shared
 * because this module is bundled into a client component and must stay
 * dependency-free (see the file header).
 */
export function mountAllowlistEnforcedFrom(
  environment: { envKeys?: string[] } | null | undefined,
): boolean {
  return Boolean(environment?.envKeys?.includes(CAPABILITY_MOUNT_ALLOWLIST));
}

export interface SandboxPosture {
  label: string;
  tier: 'success' | 'warning' | 'unknown';
  /** One-line explanation for the badge tooltip / problems list. */
  detail: string;
}

/**
 * What the Health page should say about a runner's sandbox.
 *
 * Read from the runner's isolation record when it sends one, so the cause is
 * the runner's own: the old boolean was false for four causes and this page
 * called every one "user namespaces denied", every macOS host included.
 *
 * Green means enforced. On Linux that is bwrap AND the mount allowlist: a host
 * with bwrap installed but the allowlist off is the worst case for a green
 * badge, since it looks confined and is not. On macOS it is Seatbelt, which
 * both CLIs use there; macOS has no outer mount allowlist to ask for.
 */
export function deriveSandboxPosture(hb: {
  sandboxEnabled: boolean | null;
  mountAllowlistEnforced: boolean;
  isolation?: RunnerIsolationRecord | null;
}): SandboxPosture {
  const rec = hb.isolation ?? null;
  if (rec) {
    if (!isIsolationRecordCurrent(rec)) {
      return {
        label: 'sandbox unknown',
        tier: 'unknown',
        detail: 'the isolation probe predates this runner process',
      };
    }
    const claude = rec.claude;
    // The verdict doctor and install.sh print for the same record (R-8).
    const verdict = isolationVerdict(rec);
    if (!verdict.confined) {
      // The other backend may still be confined here (Codex on Windows); its line says what it takes.
      const others = verdict.backends.filter((b) => b.level !== 'none').map((b) => b.line);
      return {
        label: verdict.reason === 'opt_out' ? 'sandbox disabled' : others.length > 0 ? 'partly sandboxed' : 'unsandboxed',
        tier: 'warning',
        detail: [`${verdict.summary} · tasks that need a sandbox go to other runners`, ...others].join(' · '),
      };
    }
    if (claude.mechanism === 'seatbelt') {
      return {
        label: 'Seatbelt',
        tier: 'success',
        detail: 'macOS Seatbelt confines Codex, and Claude where the workspace enables its sandbox · macOS has no outer mount allowlist',
      };
    }
    // bwrap: what is enforced depends on the mount allowlist, as below.
  } else if (hb.sandboxEnabled === null) {
    return {
      label: 'sandbox unknown',
      tier: 'unknown',
      detail: 'no isolation probe reported yet',
    };
  } else if (hb.sandboxEnabled === false) {
    return {
      label: 'unsandboxed',
      tier: 'warning',
      detail: 'the sandbox probe failed · this runner version does not report why',
    };
  }
  if (!hb.mountAllowlistEnforced) {
    return {
      label: 'mounts unrestricted',
      tier: 'warning',
      detail: 'bwrap available but the mount allowlist is off · the agent sees the whole host filesystem',
    };
  }
  return {
    label: 'sandboxed',
    tier: 'success',
    detail: 'bwrap namespace + mount allowlist enforced',
  };
}

// "Online now" — 3× the 60-second liveness ping interval, absorbs transient
// network hiccups. Presence only: never gate a destructive action on this (see
// the window table in @buildd/shared runner-liveness).
export const RUNNER_ONLINE_WINDOW_MS = RUNNER_LIVE_WINDOW_MS;

/**
 * Runner is "online" when its last liveness beat arrived within the past 3
 * minutes of `now`.
 *
 * `now` is a required parameter, never `Date.now()` internally: a runner
 * sitting near the threshold flips this boolean depending on exactly when
 * it's evaluated, and this function used to read the clock itself, so a
 * render-time call from a SSR-ed client component (HealthClient) could
 * disagree between the server render and the client hydration render a few
 * hundred milliseconds later. Callers that render must pass a single
 * pinned `now`; only genuinely client-only, event-driven call sites (e.g. a
 * button-click handler) should pass a fresh `Date.now()`.
 */
export function isRunnerOnline(lastHeartbeatAt: string | Date, now: number): boolean {
  return now - new Date(lastHeartbeatAt).getTime() < RUNNER_ONLINE_WINDOW_MS;
}

/**
 * Runner is "recently seen": its last beat is inside the runner-list window
 * (RUNNER_ONLINE_THRESHOLD_MS, the poll-cadence window the liveness table
 * gives runner lists and fleet capacity). Health lists and counts only these;
 * a runner gone longer drops off the page and out of its totals. It decides
 * what is listed, never whether a runner is online (`isRunnerOnline`).
 */
export function isRunnerRecentlySeen(lastHeartbeatAt: string | Date, now: number): boolean {
  return now - new Date(lastHeartbeatAt).getTime() < RUNNER_ONLINE_THRESHOLD_MS;
}

/**
 * Headless runners use a `headless://hostname` sentinel for localUiUrl instead of
 * a real HTTP URL. They have no inbound HTTP server — heartbeats flow outbound only.
 */
export function isPushOnlyRunner(localUiUrl: string): boolean {
  return localUiUrl.startsWith('headless://');
}

export interface RunnerRelevanceCandidate {
  accountId: string;
  accountTeamId: string | null;
}

/**
 * Decide which heartbeating accounts belong on a team's Health page.
 * Relevant when the account is in the team, explicitly linked to one of the
 * scoped workspaces, or has actually run workers in one. Mere claim
 * *eligibility* is not enough — open-access workspaces are claimable by any
 * account on the platform, and strangers' runners must not appear here.
 */
export function selectRelevantRunnerAccounts(
  candidates: RunnerRelevanceCandidate[],
  opts: {
    teamId: string;
    linkedAccountIds: ReadonlySet<string>;
    workedAccountIds: ReadonlySet<string>;
  },
): Set<string> {
  const relevant = new Set<string>();
  for (const c of candidates) {
    if (
      c.accountTeamId === opts.teamId ||
      opts.linkedAccountIds.has(c.accountId) ||
      opts.workedAccountIds.has(c.accountId)
    ) {
      relevant.add(c.accountId);
    }
  }
  return relevant;
}

/**
 * Other people's tasks can run on this runner: more than one person across
 * the runner's own team and the team it serves here. Unknown reads as shared,
 * so an operator's opt-out is never hidden for want of a lookup.
 */
export function isSharedRunner(
  membersByTeam: Map<string, Set<string>> | null,
  runnerTeamId: string | null,
  viewingTeamId: string,
): boolean {
  if (!membersByTeam || !runnerTeamId) return true;
  const people = new Set([...(membersByTeam.get(runnerTeamId) ?? []), ...(membersByTeam.get(viewingTeamId) ?? [])]);
  return people.size > 1;
}

/**
 * Which Health list a runner is in. Ownership class decides, never whose task
 * it ran: only a personal runner the viewer made is "Your runners". A managed
 * or team-host runner is shared (even when the viewer minted its key), and
 * another person's personal runner, from any team, is the team's to see.
 * A runner with no recorded class keeps the creator rule.
 */
export function runnerSection(r: { runnerClass?: RunnerClass; mine: boolean }): 'mine' | 'team' {
  if (r.runnerClass === 'managed' || r.runnerClass === 'team') return 'team';
  return r.mine ? 'mine' : 'team';
}
