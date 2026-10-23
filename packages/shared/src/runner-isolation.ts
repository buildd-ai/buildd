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
export type RunnerHostPlatform = 'darwin' | 'linux' | 'linux-wsl' | 'linux-container' | 'windows' | 'other';

/**
 * The OS mechanism a backend confines with on this host.
 * `windows_restricted_token` is Codex's own Windows sandbox in its unelevated
 * mode (`windows.sandbox="unelevated"`): a restricted token that confines
 * writes to the workspace and temp dirs but does not block network access.
 */
export type IsolationMechanism = 'seatbelt' | 'bwrap' | 'landlock' | 'windows_restricted_token' | 'windows_mxc' | 'none';

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
  /** Windows selection verified by this process; startup rechecks the worker home. */
  windowsSandbox?: { implementation: 'mxc' | 'unelevated'; binary: string };
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
      return platform === 'windows'
        ? 'Claude Code has no sandbox on Windows'
        : 'this platform has no sandbox the runner can use';
    case 'backend_probe_failed':
      return platform === 'darwin'
        ? 'the macOS Seatbelt sandbox (sandbox-exec) did not start'
        : platform === 'windows'
          ? "Codex's Windows sandbox (codex sandbox) did not confine a test command"
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
        : platform === 'windows'
          ? ['Check that `codex sandbox -c windows.sandbox="unelevated" -- cmd /c echo ok` runs for the runner\'s user, then restart the runner.']
          : [];
    case 'unsupported_platform':
      return platform === 'windows'
        ? ['Run the runner and Claude inside WSL2 with bubblewrap and socat installed there. From a buildd checkout in PowerShell, run bun run wsl:setup; follow apps/runner/WSL2.md for installation, login and verification.']
        : ['Run the runner on Linux (bubblewrap) or macOS (Seatbelt); on Windows, run it inside WSL2 with bubblewrap installed there.'];
  }
}

/**
 * What a `protected` task needs its backend's confinement to cover (R-4): a
 * sandbox that confines writes but leaves the network open still lets a
 * command send out whatever it can read.
 */
export const PROTECTED_SCOPE: readonly IsolationScope[] = ['write', 'network'];

/** How much of a protected task's needs a confinement covers. */
export function confinementLevel(c: BackendConfinement | null | undefined): 'full' | 'partial' | 'none' {
  if (!c || c.mechanism === 'none') return 'none';
  return PROTECTED_SCOPE.every((s) => c.scope.includes(s)) ? 'full' : 'partial';
}

/** The operator's steps when a backend is confined, but not enough for protected work. */
export function partialConfinementRemediation(platform: RunnerHostPlatform): string[] {
  return platform === 'windows'
    ? ['Run the runner inside WSL2 with bubblewrap installed there, or on Linux or macOS, to take protected Codex tasks. From a buildd checkout in PowerShell, run bun run wsl:setup; see apps/runner/WSL2.md.']
    : ['Run the runner on a host whose sandbox also confines network access (bubblewrap on Linux, Seatbelt on macOS).'];
}

/** One backend's posture on a host, in one plain line (R-8). */
export interface BackendPosture {
  backend: 'claude' | 'codex';
  /** `Claude`, `Codex`, or `Codex (read-only)` when the Codex modes differ. */
  label: string;
  level: 'full' | 'partial' | 'none';
  /** e.g. "Claude: no sandbox on Windows — its tasks go to other runners; run the runner in WSL2 to take them". */
  line: string;
}

/** What every surface says about a runner's isolation, read from its record (R-8). */
export interface IsolationVerdict {
  /** Claude has confinement on this host. */
  confined: boolean;
  mechanism: IsolationMechanism;
  /** Present exactly when `confined` is false. */
  reason: IsolationReason | null;
  /** One line: the mechanism, or the cause in plain words. */
  summary: string;
  /** isolationRemediation for the cause; empty when confined. */
  remediation: string[];
  /** One line per backend: what confines it and what that means for routing. */
  backends: BackendPosture[];
}

const MECHANISM_TEXT: Record<Exclude<IsolationMechanism, 'none'>, string> = {
  seatbelt: 'macOS Seatbelt',
  bwrap: 'bubblewrap',
  landlock: 'Landlock',
  windows_restricted_token: "Codex's Windows sandbox",
  windows_mxc: "Codex's Windows MXC sandbox",
};

const SCOPE_TEXT: Record<IsolationScope, string> = { read: 'reads', write: 'writes', network: 'network', env: 'env' };

/** What a confinement covers, e.g. "writes, network, env" or "writes only; network is open". */
function scopeText(scope: IsolationScope[]): string {
  const words = scope.map((s) => SCOPE_TEXT[s]);
  if (scope.includes('network')) return words.join(', ');
  return `${words.length === 1 ? `${words[0]} only` : words.join(', ')}; network is open`;
}

/** Where a backend is unconfined, as the phrase after "no sandbox". */
function noSandboxText(reason: IsolationReason, platform: RunnerHostPlatform): string {
  if (reason === 'unsupported_platform') return platform === 'windows' ? 'on Windows' : 'on this platform';
  return `(${isolationReasonText(reason, platform).replace(/\s*\(([^)]*)\)/g, ', $1')})`;
}

/** The short fix for refused work, as a clause; null when nothing short helps. */
function takeThemHint(reason: IsolationReason | null, platform: RunnerHostPlatform): string | null {
  if (platform === 'windows' && reason !== 'opt_out') return 'run the runner in WSL2 to take them';
  switch (reason) {
    case 'unsupported_platform':
      return 'run the runner on Linux, macOS or WSL2 to take them';
    case 'opt_out':
      return 'unset BUILDD_DISABLE_SANDBOX to take them';
    case 'bwrap_missing':
      return 'install bubblewrap to take them';
    case 'userns_sysctl_denied':
      return 'allow unprivileged user namespaces to take them';
    case 'probe_exec_failed':
      return platform === 'linux-container'
        ? 'allow user namespaces in the container to take them'
        : 'let bubblewrap create namespaces (AppArmor or seccomp) to take them';
    case 'backend_probe_failed':
      return 'run buildd doctor to see why';
    default:
      return null;
  }
}

function postureFor(
  backend: BackendPosture['backend'],
  label: string,
  c: BackendConfinement | null | undefined,
  record: RunnerIsolationRecord,
): BackendPosture {
  const level = confinementLevel(c);
  if (c && c.mechanism !== 'none') {
    const by = `${label}: confined by ${MECHANISM_TEXT[c.mechanism]} (${scopeText(c.scope)})`;
    if (level === 'full') return { backend, label, level, line: `${by} — takes protected and trusted local tasks` };
    const hint = takeThemHint(null, record.platform)?.replace(/them$/, 'protected ones');
    return { backend, label, level, line: `${by} — trusted local tasks run here confined; protected tasks go to other runners${hint ? `; ${hint}` : ''}` };
  }
  const reason = c?.reason ?? 'backend_probe_failed';
  const routing = record.reducedOptIn === true
    ? 'trusted local tasks run here unconfined (operator opt-in); protected tasks go to other runners'
    : 'its tasks go to other runners';
  const hint = takeThemHint(reason, record.platform);
  return { backend, label, level, line: `${label}: no sandbox ${noSandboxText(reason, record.platform)} — ${routing}${hint ? `; ${hint}` : ''}` };
}

/**
 * One plain line per backend (R-8): what confines it on this host and what
 * that means for the tasks it takes, by the claim's own rule
 * (isolation-policy decideTaskIsolation). The Codex modes collapse to one line
 * when they agree, which they do on every host today.
 */
export function isolationPosture(record: RunnerIsolationRecord): BackendPosture[] {
  const out = [postureFor('claude', 'Claude', record.claude, record)];
  const ro = record.codex?.['read-only'];
  const ww = record.codex?.['workspace-write'];
  if (ro?.mechanism === ww?.mechanism && ro?.reason === ww?.reason && confinementLevel(ro) === confinementLevel(ww)) {
    out.push(postureFor('codex', 'Codex', ww, record));
  } else {
    out.push(postureFor('codex', 'Codex (read-only)', ro, record), postureFor('codex', 'Codex (workspace-write)', ww, record));
  }
  return out;
}

/** A mechanism's name in plain words; `none` reads as `none`. */
export function isolationMechanismText(mechanism: IsolationMechanism): string {
  return mechanism === 'none' ? 'none' : MECHANISM_TEXT[mechanism];
}

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
      backends: isolationPosture(record),
    };
  }
  const reason = claude.reason ?? 'backend_probe_failed';
  return {
    confined: false,
    mechanism: 'none',
    reason,
    summary: isolationReasonText(reason, platform),
    remediation: isolationRemediation(reason, platform),
    backends: isolationPosture(record),
  };
}
