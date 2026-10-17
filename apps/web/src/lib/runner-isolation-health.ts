/**
 * What Health says about a runner's isolation (Living Spec "Runner isolation",
 * R-9, R-10, AC-10): the Problems line, only for a policy deviation someone can
 * act on, and the runner detail, in plain words.
 *
 * Client-safe: imported by HealthClient, so no DB (see runner-heartbeats-shared).
 *
 * Policy (@buildd/shared isolation-policy): a runner without confinement
 * gets no protected task, so losing it is a Problem. Reduced confinement is
 * allowed only where its operator chose it (the BUILDD_DISABLE_SANDBOX opt-out,
 * or the BUILDD_ALLOW_REDUCED_ISOLATION opt-in for trusted local work) on a
 * runner nobody else's tasks run on. "Protected work pending" still reads any
 * pending task: Health does not resolve each task's requirement.
 */

import {
  isIsolationRecordCurrent,
  isolationMechanismText,
  isolationReasonText,
  isolationRemediation,
  type BackendConfinement,
  type RunnerHostPlatform,
} from '@buildd/shared';
import type { RunnerHeartbeat } from './runner-heartbeats-shared';

export type IsolationRunner = Pick<
  RunnerHeartbeat,
  'accountName' | 'sandboxEnabled' | 'sandboxProbeAt' | 'mountAllowlistEnforced' | 'isolation' | 'shared'
>;

export interface IsolationProblem {
  title: string;
  detail: string;
}

export { isSharedRunner } from './runner-heartbeats-shared';

const FIXER = "The runner's operator fixes this on its host; buildd never changes host security settings.";

/** The cause without the setting or command names in brackets, for the overview line. */
function plainCause(reason: NonNullable<BackendConfinement['reason']>, platform: RunnerHostPlatform): string {
  return isolationReasonText(reason, platform).replace(/\s*\([^)]*\)/g, '');
}

function sentence(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The Problems line for a runner, or null when its isolation matches policy
 * (R-9). Three deviations count: a runner meant for protected work lost
 * confinement, an opt-out on a runner other people's tasks run on, and an
 * unknown or stale probe while protected work waits. Bubblewrap with the mount
 * allowlist off is confined and the default install, so it stays in detail.
 */
export function isolationProblem(
  hb: IsolationRunner,
  ctx: { protectedWorkPending: boolean },
): IsolationProblem | null {
  const name = hb.accountName || 'Runner';
  const rec = hb.isolation;
  const unknown = rec ? !isIsolationRecordCurrent(rec) : hb.sandboxEnabled === null;
  if (unknown) {
    if (!ctx.protectedWorkPending) return null;
    return {
      title: `${name}: sandbox not confirmed`,
      detail: rec
        ? "Tasks are waiting, and this runner hasn't checked its sandbox since it last started."
        : "Tasks are waiting, and this runner hasn't reported a sandbox check yet.",
    };
  }
  if (rec) {
    if (rec.claude.mechanism !== 'none') return null;
    const reason = rec.claude.reason ?? 'backend_probe_failed';
    // The operator chose reduced confinement on a runner only they use.
    if (!hb.shared && (reason === 'opt_out' || rec.reducedOptIn === true)) return null;
    if (reason === 'opt_out') {
      return {
        title: `${name}: sandbox turned off`,
        detail: "Its operator turned the sandbox off, and other people's tasks run on this runner.",
      };
    }
    return {
      title: `${name}: not sandboxed`,
      detail: `${sentence(plainCause(reason, rec.platform))}, so tasks that need a sandbox wait for another runner. ${FIXER}`,
    };
  }
  if (hb.sandboxEnabled === false) {
    return {
      title: `${name}: not sandboxed`,
      detail: `The sandbox check failed, and this runner is too old to say why; it takes no tasks until it is updated. ${FIXER}`,
    };
  }
  return null;
}

const PLATFORM_TEXT: Record<RunnerHostPlatform, string> = {
  darwin: 'macOS',
  linux: 'Linux',
  'linux-wsl': 'Linux on WSL',
  'linux-container': 'Linux container',
  other: 'a platform buildd has no sandbox for',
};

export interface RunnerIsolationDetail {
  /** Null when the runner predates the isolation record. */
  platform: string | null;
  /** One row per backend and mode: what confines it here, `none`, or `unknown`. */
  backends: { label: string; value: string; confined: boolean }[];
  /** On bubblewrap, whether the agent sees the whole host filesystem. */
  filesystem: string | null;
  /** Why isolation is reduced or unknown; null when confined. */
  cause: string | null;
  /** Why policy allows a reduced runner; null when it doesn't. */
  allowed: string | null;
  probeAt: string | null;
  probeCurrent: boolean;
  /** Who fixes it, when something needs fixing. */
  fixer: string | null;
  /** The runner operator's steps. */
  steps: string[];
}

const BACKEND_ROWS = [
  { label: 'Claude', pick: (r: NonNullable<IsolationRunner['isolation']>) => r.claude },
  { label: 'Codex, read-only', pick: (r: NonNullable<IsolationRunner['isolation']>) => r.codex['read-only'] },
  { label: 'Codex, can edit files', pick: (r: NonNullable<IsolationRunner['isolation']>) => r.codex['workspace-write'] },
] as const;

/** Runner detail for isolation (R-10): platform, each backend and mode, cause, probe age, fixer and steps. */
export function runnerIsolationDetail(hb: IsolationRunner): RunnerIsolationDetail {
  const rec = hb.isolation;
  if (!rec) {
    const known = hb.sandboxEnabled !== null;
    return {
      platform: null,
      backends: [],
      filesystem: null,
      cause: hb.sandboxEnabled === false
        ? "The sandbox check failed, and this runner version doesn't say why."
        : known ? null : "This runner hasn't reported a sandbox check yet.",
      allowed: null,
      probeAt: hb.sandboxProbeAt,
      probeCurrent: known,
      fixer: hb.sandboxEnabled === true ? null : FIXER,
      steps: hb.sandboxEnabled === true ? [] : ['Update the runner, then run buildd doctor on its host to see the cause.'],
    };
  }

  // A boolean, not the type guard: its false branch would narrow `rec` to never.
  const current: boolean = isIsolationRecordCurrent(rec);
  if (!current) {
    return {
      platform: PLATFORM_TEXT[rec.platform] ?? rec.platform,
      backends: BACKEND_ROWS.map(b => ({ label: b.label, value: 'unknown', confined: false })),
      filesystem: null,
      cause: 'The last sandbox check came from an earlier run of this runner, so what is enforced now is unknown.',
      allowed: null,
      probeAt: rec.probeAt,
      probeCurrent: false,
      fixer: FIXER,
      steps: ['Restart the runner so it checks its sandbox again.'],
    };
  }

  const backends = BACKEND_ROWS.map(b => {
    const c = b.pick(rec);
    return { label: b.label, value: isolationMechanismText(c?.mechanism ?? 'none'), confined: !!c && c.mechanism !== 'none' };
  });
  const usesBwrap = [rec.claude, rec.codex['read-only'], rec.codex['workspace-write']].some(c => c?.mechanism === 'bwrap');
  const filesystem = usesBwrap
    ? hb.mountAllowlistEnforced
      ? "Host filesystem: limited to the task's own files (mount allowlist on)."
      : 'Host filesystem: the agent can read the whole host filesystem (mount allowlist off).'
    : null;

  // The first unconfined backend and mode names the cause; they share one probe on most hosts.
  const lost = [rec.claude, rec.codex['read-only'], rec.codex['workspace-write']].find(c => c && c.mechanism === 'none');
  const steps: string[] = [];
  let cause: string | null = null;
  let allowed: string | null = null;
  if (lost) {
    const reason = lost.reason ?? 'backend_probe_failed';
    cause = `${sentence(isolationReasonText(reason, rec.platform))}.`;
    steps.push(...isolationRemediation(reason, rec.platform));
    if (reason === 'opt_out' && !hb.shared) {
      allowed = "Allowed: only its operator's own tasks run on this runner.";
    } else if (rec.reducedOptIn === true && !hb.shared) {
      allowed = "Allowed: its operator chose to run their own trusted tasks without a sandbox here. Tasks that need one go to another runner.";
    }
  }
  if (usesBwrap && !hb.mountAllowlistEnforced) {
    steps.push("Set BUILDD_SANDBOX_MOUNT_ALLOWLIST=1 in the runner's environment and restart it, to limit the agent to the task's files.");
  }

  return {
    platform: PLATFORM_TEXT[rec.platform] ?? rec.platform,
    backends,
    filesystem,
    cause,
    allowed,
    probeAt: rec.probeAt,
    probeCurrent: true,
    // An allowed opt-out needs no fix; its steps say how to turn the sandbox back on.
    fixer: allowed ? null : steps.length > 0 || cause ? FIXER : null,
    steps,
  };
}
