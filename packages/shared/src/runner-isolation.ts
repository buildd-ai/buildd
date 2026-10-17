/**
 * The confinement a runner can actually apply, per backend and mode, on the
 * host it runs on (Living Spec "Runner isolation", R-1..R-3, R-11).
 *
 * The runner probes once per process and sends this record in its heartbeat
 * `environment.isolation`. It replaces the single `sandboxEnabled` boolean as
 * the source of truth: that boolean was `false` for four different causes and
 * the dashboard read every one as "user namespaces denied", including every
 * macOS host, where neither CLI uses bubblewrap at all.
 *
 * Pure and dependency-free: imported by the runner, the web API and client
 * components alike.
 */

/** R-1: the host class, from evidence the runner records. */
export type RunnerHostPlatform = 'darwin' | 'linux' | 'linux-wsl' | 'linux-container' | 'other';

/** The OS mechanism a backend confines with on this host. */
export type IsolationMechanism = 'seatbelt' | 'bwrap' | 'landlock' | 'none';

/** What the confinement restricts. */
export type IsolationScope = 'read' | 'write' | 'network' | 'env';

/** R-2: why a backend has no confinement here. */
export type IsolationReason =
  | 'opt_out'
  | 'userns_sysctl_denied'
  | 'bwrap_missing'
  | 'probe_exec_failed'
  | 'unsupported_platform'
  | 'backend_probe_failed';

export interface BackendConfinement {
  mechanism: IsolationMechanism;
  scope: IsolationScope[];
  /** Present exactly when `mechanism` is `none`. */
  reason?: IsolationReason;
}

export type CodexSandboxMode = 'read-only' | 'workspace-write';

export interface RunnerIsolationRecord {
  platform: RunnerHostPlatform;
  /** The markers `platform` was decided from, e.g. `process.platform=linux`, `/.dockerenv`. */
  evidence: string[];
  claude: BackendConfinement;
  codex: Record<CodexSandboxMode, BackendConfinement>;
  /** When this process ran the probe. */
  probeAt: string;
  /** When this runner process started; a probe older than this is not this process's (R-11). */
  processStartedAt: string;
  runnerVersion: string;
  /**
   * The runner operator opted in to running `trusted_local` work with reduced
   * confinement (BUILDD_ALLOW_REDUCED_ISOLATION=1, or the BUILDD_DISABLE_SANDBOX
   * opt-out). Absent or false: nothing runs reduced here (R-5, ./isolation-policy).
   */
  reducedOptIn?: boolean;
}

function isConfinement(v: unknown): v is BackendConfinement {
  return !!v && typeof v === 'object' && typeof (v as { mechanism?: unknown }).mechanism === 'string';
}

/**
 * The record from a heartbeat's `environment` jsonb, or null when it is absent
 * or not shaped like one. Older rows and newer writers fill that column
 * differently, so this checks what Health dereferences instead of trusting a cast.
 */
export function readIsolationRecord(environment: unknown): RunnerIsolationRecord | null {
  if (!environment || typeof environment !== 'object') return null;
  const rec = (environment as { isolation?: unknown }).isolation;
  if (!rec || typeof rec !== 'object') return null;
  const r = rec as {
    platform?: unknown;
    claude?: unknown;
    codex?: unknown;
    probeAt?: unknown;
    processStartedAt?: unknown;
  };
  if (typeof r.platform !== 'string' || typeof r.probeAt !== 'string' || typeof r.processStartedAt !== 'string') return null;
  if (!isConfinement(r.claude) || !r.codex || typeof r.codex !== 'object') return null;
  return rec as RunnerIsolationRecord;
}

/** R-11: a probe that is absent, or predates the process reporting it, says nothing. */
export function isIsolationRecordCurrent(record: RunnerIsolationRecord | null | undefined): record is RunnerIsolationRecord {
  if (!record || typeof record !== 'object') return false;
  const probe = Date.parse(record.probeAt);
  const started = Date.parse(record.processStartedAt);
  if (Number.isNaN(probe) || Number.isNaN(started)) return false;
  return probe >= started;
}

/** Plain words for a reason, for Health, `doctor` and runner logs alike (R-8, R-10). */
export function isolationReasonText(reason: IsolationReason, platform: RunnerHostPlatform): string {
  switch (reason) {
    case 'opt_out':
      return 'sandbox disabled by the runner operator (BUILDD_DISABLE_SANDBOX=1)';
    case 'userns_sysctl_denied':
      return 'the kernel denies unprivileged user namespaces (kernel.unprivileged_userns_clone=0)';
    case 'bwrap_missing':
      return platform === 'linux-wsl'
        ? 'bubblewrap is not installed in this WSL distribution'
        : 'bubblewrap is not installed on this host';
    case 'probe_exec_failed':
      return platform === 'linux-container'
        ? 'bubblewrap could not create namespaces inside this container (seccomp or AppArmor profile)'
        : 'bubblewrap is installed but could not create namespaces (seccomp, AppArmor or a runtime denial)';
    case 'unsupported_platform':
      return 'this platform has no sandbox the runner can use';
    case 'backend_probe_failed':
      return platform === 'darwin'
        ? 'the macOS Seatbelt sandbox (sandbox-exec) did not start'
        : "the backend's own sandbox probe failed";
  }
}

/**
 * Platform-specific steps the runner OPERATOR takes; buildd never changes host
 * security settings itself (R-8). Empty when nothing on the host would help.
 */
export function isolationRemediation(reason: IsolationReason, platform: RunnerHostPlatform): string[] {
  switch (reason) {
    case 'opt_out':
      return ['Unset BUILDD_DISABLE_SANDBOX and restart the runner.'];
    case 'userns_sysctl_denied':
      return ['Allow unprivileged user namespaces: sysctl -w kernel.unprivileged_userns_clone=1 (persist it in /etc/sysctl.d), then restart the runner.'];
    case 'bwrap_missing':
      return ['Install bubblewrap (apt install bubblewrap, dnf install bubblewrap, or your distribution\'s package), then restart the runner.'];
    case 'probe_exec_failed':
      return platform === 'linux-container'
        ? ['Run the container with a profile that allows user namespaces, e.g. --security-opt seccomp=unconfined --security-opt apparmor=unconfined, then restart the runner.']
        : ['Check the AppArmor or seccomp policy that blocks bwrap (on Ubuntu 24.04+: kernel.apparmor_restrict_unprivileged_userns=0 or an AppArmor profile for bwrap), then restart the runner.'];
    case 'backend_probe_failed':
      return platform === 'darwin'
        ? ['Check that /usr/bin/sandbox-exec runs for the runner\'s user (it is part of macOS), then restart the runner.']
        : [];
    case 'unsupported_platform':
      return [];
  }
}

/** What every surface says about a runner's isolation, read from its record (R-8). */
export interface IsolationVerdict {
  /** Claude has confinement on this host. Codex reads the same probe on every host today. */
  confined: boolean;
  mechanism: IsolationMechanism;
  /** Present exactly when `confined` is false. */
  reason: IsolationReason | null;
  /** One line: the mechanism, or the cause in plain words. */
  summary: string;
  /** isolationRemediation for the cause; empty when confined. */
  remediation: string[];
}

const MECHANISM_TEXT: Record<Exclude<IsolationMechanism, 'none'>, string> = {
  seatbelt: 'macOS Seatbelt',
  bwrap: 'bubblewrap',
  landlock: 'Landlock',
};

/**
 * The one verdict `install.sh`, `buildd doctor` and Health give for a host
 * (R-8, AC-8). Health, doctor and the installer differ in layout only: the
 * cause and the steps are these.
 */
export function isolationVerdict(record: RunnerIsolationRecord): IsolationVerdict {
  const { claude, platform } = record;
  if (claude.mechanism !== 'none') {
    return {
      confined: true,
      mechanism: claude.mechanism,
      reason: null,
      summary: `${MECHANISM_TEXT[claude.mechanism]} confines Claude and Codex on this host`,
      remediation: [],
    };
  }
  const reason = claude.reason ?? 'backend_probe_failed';
  return {
    confined: false,
    mechanism: 'none',
    reason,
    summary: isolationReasonText(reason, platform),
    remediation: isolationRemediation(reason, platform),
  };
}
