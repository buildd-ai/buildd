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
 * runner nobody else's tasks run on. Pending work is counted per runner with
 * the claim's own rule (decideTaskIsolation), so "N waiting tasks can't run
 * here" is the number its next claim would defer as isolation_unenforced.
 */

import {
  confinementLevel,
  decideTaskIsolation,
  isIsolationRecordCurrent,
  isolationMechanismText,
  isolationReasonText,
  isolationRemediation,
  resolveIsolationRequirement,
  taskCodexSandboxMode,
  type BackendConfinement,
  type CodexSandboxMode,
  type IsolationBackend,
  type IsolationRequirement,
  type RunnerHostPlatform,
  type RunnerIsolationRecord,
} from '@buildd/shared';
import type { RunnerHeartbeat } from './runner-heartbeats-shared';

export type IsolationRunner = Pick<
  RunnerHeartbeat,
  'accountName' | 'sandboxEnabled' | 'sandboxProbeAt' | 'mountAllowlistEnforced' | 'isolation' | 'shared'
> & Partial<Pick<RunnerHeartbeat, 'mine' | 'isolationBlocked'>>;

export interface IsolationProblem {
  title: string;
  detail: string;
}

export { isSharedRunner } from './runner-heartbeats-shared';

const FIXER = "The runner's operator fixes this on its host; buildd never changes host security settings.";
const MINE_FIXER = "You fix this on the runner's host; buildd never changes host security settings.";

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

export const PLATFORM_TEXT: Record<RunnerHostPlatform, string> = {
  darwin: 'macOS',
  linux: 'Linux',
  'linux-wsl': 'Linux on WSL',
  'linux-container': 'Linux container',
  windows: 'Windows',
  other: 'a platform buildd has no sandbox for',
};


/**
 * The four things Health tells apart about a runner's sandbox: confined and
 * checked (`verified`), turned off by its operator (`opted_out`), never
 * checked or checked by an earlier process (`unknown`, `stale`), and lost
 * (`failed`). A reduced-isolation opt-in on a lost sandbox is still `failed`:
 * the operator allowed the fallback, they did not choose the cause.
 */
export type RunnerIsolationState = 'verified' | 'opted_out' | 'unknown' | 'stale' | 'failed';

export interface RunnerIsolationDetail {
  state: RunnerIsolationState;
  /** The one line the row shows, e.g. "Sandbox disabled by you". */
  headline: string;
  /** Someone needs to act: shown in warning colour and opened by default. */
  attention: boolean;
  /** Null when the runner predates the isolation record. */
  platform: string | null;
  /** One row per backend and mode: what confines it here, `none`, or `unknown`. */
  backends: { label: string; value: string; confined: boolean }[];
  /** Which tasks this runner takes, by isolation requirement. */
  eligibility: string[];
  /** Waiting tasks this runner refuses, and what would let it take them; null when none. */
  blocked: string | null;
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

/**
 * Rows that agree collapse to one: a macOS host prints "Claude and Codex:
 * macOS Seatbelt" once, not once per backend and mode. Differing rows stay
 * separate so a partly confined runner still shows which mode lost it.
 */
function collapseBackends(rows: RunnerIsolationDetail['backends']): RunnerIsolationDetail['backends'] {
  if (rows.length > 1 && rows.every(r => r.value === rows[0].value && r.confined === rows[0].confined)) {
    return [{ label: 'Claude and Codex', value: rows[0].value, confined: rows[0].confined }];
  }
  return rows;
}

function fixerFor(hb: IsolationRunner): string {
  return hb.mine ? MINE_FIXER : FIXER;
}

const TAKES_NOTHING = 'Takes no tasks until it reports a current sandbox check.';

function blockedLine(hb: IsolationRunner, state: RunnerIsolationState): string | null {
  const b = hb.isolationBlocked;
  if (!b) return null;
  const n = b.protected + b.trustedLocal;
  if (n === 0) return null;
  const tasks = n === 1 ? '1 waiting task' : `${n} waiting tasks`;
  // Its eligibility line already says it takes nothing; the row's summary carries the count.
  if (state === 'unknown' || state === 'stale') return null;
  if (b.trustedLocal === 0) {
    const need = n === 1 ? 'needs' : 'need';
    const change = state === 'opted_out'
      ? 'To run them here, turn its sandbox back on; otherwise they wait for a sandboxed runner.'
      : 'To run them here, fix its sandbox; otherwise they wait for a sandboxed runner.';
    return `${tasks} ${need} a sandbox, so they can't run here. ${change}`;
  }
  return `${tasks} can't run here: protected tasks need a sandbox, and trusted local ones need its operator's opt-in to run without one.`;
}

/** Runner detail for isolation (R-10): state, platform, each backend and mode, eligibility, cause, probe age, fixer and steps. */
export function runnerIsolationDetail(hb: IsolationRunner): RunnerIsolationDetail {
  const rec = hb.isolation;
  if (!rec) {
    const known = hb.sandboxEnabled !== null;
    const state: RunnerIsolationState = hb.sandboxEnabled === true ? 'verified' : known ? 'failed' : 'unknown';
    return {
      state,
      headline: state === 'verified' ? 'Sandbox on' : state === 'failed' ? 'No sandbox' : 'Sandbox not confirmed',
      attention: state !== 'verified',
      platform: null,
      backends: [],
      eligibility: [state === 'verified' ? 'Takes tasks; this runner version does not say which.' : TAKES_NOTHING],
      blocked: blockedLine(hb, state === 'verified' ? 'verified' : 'unknown'),
      filesystem: null,
      cause: hb.sandboxEnabled === false
        ? "The sandbox check failed, and this runner version doesn't say why."
        : known ? null : "This runner hasn't reported a sandbox check yet.",
      allowed: null,
      probeAt: hb.sandboxProbeAt,
      probeCurrent: known,
      fixer: hb.sandboxEnabled === true ? null : fixerFor(hb),
      steps: hb.sandboxEnabled === true ? [] : ['Update the runner, then run buildd doctor on its host to see the cause.'],
    };
  }

  // A boolean, not the type guard: its false branch would narrow `rec` to never.
  const current: boolean = isIsolationRecordCurrent(rec);
  if (!current) {
    return {
      state: 'stale',
      headline: 'Sandbox check out of date',
      attention: true,
      platform: PLATFORM_TEXT[rec.platform] ?? rec.platform,
      backends: collapseBackends(BACKEND_ROWS.map(b => ({ label: b.label, value: 'unknown', confined: false }))),
      eligibility: [TAKES_NOTHING],
      blocked: blockedLine(hb, 'stale'),
      filesystem: null,
      cause: 'The last sandbox check came from an earlier run of this runner, so what is enforced now is unknown.',
      allowed: null,
      probeAt: rec.probeAt,
      probeCurrent: false,
      fixer: fixerFor(hb),
      steps: ['Restart the runner so it checks its sandbox again.'],
    };
  }

  const backends = collapseBackends(BACKEND_ROWS.map(b => {
    const c = b.pick(rec);
    const level = confinementLevel(c);
    const value = c?.reason === 'opt_out'
      ? 'off'
      : `${isolationMechanismText(c?.mechanism ?? 'none')}${level === 'partial' ? ' (writes only, network open)' : ''}`;
    return { label: b.label, value, confined: level !== 'none' };
  }));
  const usesBwrap = [rec.claude, rec.codex['read-only'], rec.codex['workspace-write']].some(c => c?.mechanism === 'bwrap');
  const filesystem = usesBwrap
    ? hb.mountAllowlistEnforced
      ? "Host filesystem: limited to the task's own files (mount allowlist on)."
      : 'Host filesystem: the agent can read the whole host filesystem (mount allowlist off).'
    : null;

  // The first unconfined backend and mode names the cause; they share one probe on most hosts.
  const lost = [rec.claude, rec.codex['read-only'], rec.codex['workspace-write']].find(c => c && c.mechanism === 'none');
  const reason = lost ? lost.reason ?? 'backend_probe_failed' : null;
  const state: RunnerIsolationState = !lost ? 'verified' : reason === 'opt_out' ? 'opted_out' : 'failed';
  const steps: string[] = [];
  let cause: string | null = null;
  let allowed: string | null = null;
  const eligibility: string[] = [];
  if (lost && reason) {
    cause = `${sentence(isolationReasonText(reason, rec.platform))}.`;
    steps.push(...isolationRemediation(reason, rec.platform));
    if (reason === 'opt_out' && !hb.shared) {
      allowed = "Allowed: only its operator's own tasks run on this runner.";
    } else if (rec.reducedOptIn === true && !hb.shared) {
      allowed = "Allowed: its operator chose to run their own trusted tasks without a sandbox here. Tasks that need one go to another runner.";
    }
    // The claim rule (decideTaskIsolation): protected never runs unconfined;
    // trusted local runs reduced only with the operator's opt-in.
    const partly = rec.claude.mechanism !== 'none' || [rec.codex['read-only'], rec.codex['workspace-write']].some(c => c && c.mechanism !== 'none');
    eligibility.push(rec.reducedOptIn === true
      ? 'Trusted local tasks run here without a sandbox, as its operator chose.'
      : partly
        ? 'Takes tasks only for the backends it confines.'
        : 'Takes no tasks: protected tasks need a sandbox, and trusted local tasks need its operator\'s opt-in to run without one.');
    if (rec.reducedOptIn === true || partly) eligibility.push('Protected tasks go to another runner with a working sandbox.');
  } else {
    eligibility.push('Takes protected and trusted local tasks.');
  }
  if (usesBwrap && !hb.mountAllowlistEnforced) {
    steps.push("Set BUILDD_SANDBOX_MOUNT_ALLOWLIST=1 in the runner's environment and restart it, to limit the agent to the task's files.");
  }

  const headline = state === 'verified'
    ? 'Sandbox on'
    : state === 'opted_out'
      ? hb.mine ? 'Sandbox disabled by you' : 'Sandbox disabled by its operator'
      : 'No sandbox';
  return {
    state,
    headline,
    // An opt-out the operator chose, on a runner only they use, is a setting, not a fault.
    attention: state === 'failed' ? !allowed : state === 'opted_out' ? !!hb.shared : false,
    platform: PLATFORM_TEXT[rec.platform] ?? rec.platform,
    backends,
    eligibility,
    blocked: blockedLine(hb, state),
    filesystem,
    cause,
    allowed,
    probeAt: rec.probeAt,
    probeCurrent: true,
    // An allowed opt-out needs no fix; its steps say how to turn the sandbox back on.
    fixer: allowed ? null : steps.length > 0 || cause ? fixerFor(hb) : null,
    steps,
  };
}

/** A pending task as the claim's isolation gate sees it. */
export interface PendingIsolationTask {
  requirement: IsolationRequirement;
  backend: IsolationBackend;
  codexMode: CodexSandboxMode;
}

/**
 * A pending task's requirement, backend and Codex mode, resolved exactly as
 * the claim route's isolation gate does (resolveIsolationRequirement,
 * taskCodexSandboxMode). `teamMemberCount` is the workspace team's size, null
 * when unknown (which resolves to protected).
 */
export function pendingIsolationTask(
  row: { backend: string | null; kind: string | null; context: unknown; isolationPolicy: unknown; accessMode: string | null },
  teamMemberCount: number | null,
): PendingIsolationTask {
  const { requirement } = resolveIsolationRequirement({
    workspacePolicy: row.isolationPolicy,
    workspaceAccessMode: row.accessMode,
    teamMemberCount,
  });
  return {
    requirement,
    backend: row.backend === 'codex' ? 'codex' : 'claude',
    codexMode: taskCodexSandboxMode(row.kind, row.context),
  };
}

export interface IsolationBlockedCounts {
  protected: number;
  trustedLocal: number;
}

function refuses(record: RunnerIsolationRecord | null, t: PendingIsolationTask): boolean {
  return !decideTaskIsolation({ requirement: t.requirement, record, backend: t.backend, codexMode: t.codexMode }).ok;
}

/** Pending tasks a runner's claim would defer as isolation_unenforced, by requirement. */
export function isolationBlockedCounts(record: RunnerIsolationRecord | null, pending: PendingIsolationTask[]): IsolationBlockedCounts {
  const out = { protected: 0, trustedLocal: 0 };
  for (const t of pending) {
    if (!refuses(record, t)) continue;
    if (t.requirement === 'protected') out.protected++;
    else out.trustedLocal++;
  }
  return out;
}

/** Pending tasks every online runner refuses for isolation: they wait for a runner nobody has. */
export function isolationStrandedCount(records: (RunnerIsolationRecord | null)[], pending: PendingIsolationTask[]): number {
  if (records.length === 0) return 0;
  return pending.filter(t => records.every(r => refuses(r, t))).length;
}

/** The Problems line for tasks no online runner's sandbox lets it take, or null. */
export function isolationStrandedProblem(stranded: number): IsolationProblem | null {
  if (stranded <= 0) return null;
  return {
    title: stranded === 1 ? '1 task needs a sandbox no online runner has' : `${stranded} tasks need a sandbox no online runner has`,
    detail: "They wait until a runner with a working sandbox is online. Each runner's Sandbox line says what it takes and what to change.",
  };
}
