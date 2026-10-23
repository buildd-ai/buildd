/**
 * What confinement this runner can apply, per backend and mode, on this host
 * (Living Spec "Runner isolation", R-1, R-2, R-6).
 *
 * The bwrap probe used to be the only question asked, on every platform, and
 * its one boolean decided everything: on macOS, where `which bwrap` always
 * fails, the runner turned off Claude's sandbox and env scrub and moved Codex
 * to danger-full-access, though both CLIs confine with Seatbelt there and
 * never touch bubblewrap. This module asks each backend's own question on each
 * host and keeps the cause when the answer is no.
 */
import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import {
  isolationReasonText,
  reducedIsolationOptedIn,
  type BackendConfinement,
  type CodexSandboxMode,
  type IsolationBackend,
  type IsolationReason,
  type RunnerHostPlatform,
  type RunnerIsolationRecord,
  type TaskIsolationDecision,
} from '@buildd/shared';
import { probeCodexWindowsModes, resolveCodexBinary, runInCodexSandbox, type WindowsSandboxModes } from './codex-windows-sandbox';
import { resolveBuilddHome } from './buildd-home';

/** Why a bwrap probe failed, in the isolation record's vocabulary. */
export type BwrapProbeFailure = Extract<IsolationReason, 'opt_out' | 'userns_sysctl_denied' | 'bwrap_missing' | 'probe_exec_failed'>;
export type BwrapProbeResult = { ok: true } | { ok: false; reason: BwrapProbeFailure };

/** The namespaces Claude Code's inner sandbox unshares (see env-scan checkBwrapSupport). */
export const CLAUDE_INNER_SANDBOX_UNSHARE = ['--unshare-user', '--unshare-pid', '--unshare-net'] as const;

/**
 * Can bwrap create the given namespaces here, and if not, which of four causes:
 * the operator opt-out, the kernel sysctl, bwrap not installed, or the exec
 * itself failing (seccomp, AppArmor, timeout).
 */
export function probeBwrapNamespacesDetailed(unshareFlags: readonly string[], loaderBinds = false): BwrapProbeResult {
  // Operator escape hatch — set when the kernel/container config is known-bad
  // and the proc-file approach below is insufficient (e.g. inside a user namespace
  // where the sysctl is not propagated correctly).
  if (process.env.BUILDD_DISABLE_SANDBOX === '1') return { ok: false, reason: 'opt_out' };

  // Fast-path: read the kernel sysctl directly. If it's "0", user namespace
  // creation is disabled and every --unshare-user bwrap invocation will fail.
  if (process.platform === 'linux') {
    try {
      const val = readFileSync('/proc/sys/kernel/unprivileged_userns_clone', 'utf8').trim();
      if (val === '0') return { ok: false, reason: 'userns_sysctl_denied' };
    } catch { /* sysctl not present on all kernel configs — fall through */ }
  }

  try {
    execSync('which bwrap', { timeout: 2000, stdio: 'pipe' });
  } catch {
    return { ok: false, reason: 'bwrap_missing' };
  }
  // loaderBinds: on merged-usr hosts /lib and /lib64 are symlinks into /usr and
  // a binary's ELF interpreter is named by that path, so with /usr alone the
  // exec fails ENOENT and the probe misreads it as "no namespaces".
  const binds = loaderBinds ? ' --ro-bind-try /bin /bin --ro-bind-try /lib /lib --ro-bind-try /lib64 /lib64' : '';
  try {
    execSync(
      `bwrap ${unshareFlags.join(' ')} --uid 0 --gid 0 --ro-bind /usr /usr${binds} --proc /proc --dev /dev -- echo ok`,
      { timeout: 5000, stdio: 'pipe' },
    );
    return { ok: true };
  } catch {
    return { ok: false, reason: 'probe_exec_failed' };
  }
}

/**
 * The cause, once the cached Claude bwrap probe has said no. A probe that now
 * passes means the earlier no came from a runtime denial (the session's own
 * bwrap aborted), which is an exec failure too.
 */
export function diagnoseClaudeBwrapFailure(): BwrapProbeFailure {
  const result = probeBwrapNamespacesDetailed(CLAUDE_INNER_SANDBOX_UNSHARE, true);
  return result.ok ? 'probe_exec_failed' : result.reason;
}

export interface HostProbeDeps {
  platform: NodeJS.Platform;
  env: Record<string, string | undefined>;
  exists(path: string): boolean;
  read(path: string): string | null;
}

const realHostDeps = (): HostProbeDeps => ({
  platform: process.platform,
  env: process.env,
  exists: existsSync,
  read: (path) => {
    try { return readFileSync(path, 'utf8'); } catch { return null; }
  },
});

/** R-1: the host class, with the markers it was decided from. */
export function detectHostPlatform(deps: HostProbeDeps = realHostDeps()): { platform: RunnerHostPlatform; evidence: string[] } {
  const evidence = [`process.platform=${deps.platform}`];
  if (deps.platform === 'darwin') return { platform: 'darwin', evidence };
  if (deps.platform === 'win32') return { platform: 'windows', evidence };
  if (deps.platform !== 'linux') return { platform: 'other', evidence };

  if (deps.env.WSL_DISTRO_NAME) evidence.push('env WSL_DISTRO_NAME');
  if (deps.exists('/proc/sys/fs/binfmt_misc/WSLInterop')) evidence.push('/proc/sys/fs/binfmt_misc/WSLInterop');
  if (/microsoft|wsl/i.test(deps.read('/proc/version') ?? '')) evidence.push('/proc/version names Microsoft');
  if (evidence.length > 1) return { platform: 'linux-wsl', evidence };

  if (deps.exists('/.dockerenv')) evidence.push('/.dockerenv');
  if (deps.exists('/run/.containerenv')) evidence.push('/run/.containerenv');
  if (deps.env.KUBERNETES_SERVICE_HOST) evidence.push('env KUBERNETES_SERVICE_HOST');
  if (/docker|kubepods|containerd|libpod|lxc/.test(deps.read('/proc/1/cgroup') ?? '')) evidence.push('/proc/1/cgroup names a container runtime');
  if (evidence.length > 1) return { platform: 'linux-container', evidence };

  return { platform: 'linux', evidence };
}

/**
 * macOS Seatbelt, the mechanism both Claude Code and Codex confine with on
 * darwin. They run `/usr/bin/sandbox-exec`; the probe runs it with a trivial
 * profile, so a host where it cannot start is told apart from one where it can.
 */
export function probeSeatbelt(): boolean {
  try {
    execSync(`/usr/bin/sandbox-exec -p '(version 1)(allow default)' /usr/bin/true`, { timeout: 5000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

export interface IsolationProbeInputs {
  host: { platform: RunnerHostPlatform; evidence: string[] };
  /** BUILDD_DISABLE_SANDBOX=1. */
  optOut: boolean;
  /** Linux hosts: Claude's inner-sandbox bwrap probe. Ignored elsewhere. */
  bwrap: BwrapProbeResult | null;
  /** darwin: the Seatbelt probe. Ignored elsewhere. */
  seatbelt: boolean | null;
  /** windows: Codex's unelevated Windows sandbox probe (./codex-windows-sandbox). Ignored elsewhere. */
  codexWindows?: boolean | null;
  codexWindowsModes?: WindowsSandboxModes | null;
  codexWindowsBinary?: string | null;
  probeAt: string;
  processStartedAt: string;
  runnerVersion: string;
  /** The operator's opt-in to reduced confinement for trusted_local work (R-5). */
  reducedOptIn?: boolean;
}

const CONFINED_SCOPE: BackendConfinement['scope'] = ['write', 'network', 'env'];
const CODEX_SCOPE: BackendConfinement['scope'] = ['write', 'network'];
/** Codex's unelevated Windows sandbox: a restricted token, no network confinement. */
const CODEX_WINDOWS_SCOPE: BackendConfinement['scope'] = ['write'];

const none = (reason: IsolationReason): BackendConfinement => ({ mechanism: 'none', scope: [], reason });

/**
 * R-2: the record, from what the probes found. Pure.
 *
 * Codex on Linux is still read through Claude's bwrap probe: that was PR
 * #2935's premise and the CLI's Linux mechanism for the pinned version is an
 * open question of the spec. On darwin both backends read Seatbelt, and the
 * bwrap probe is never consulted (R-6). On Windows Claude Code has no
 * sandbox, and Codex reads its own Windows sandbox probe.
 */
export function buildIsolationRecord(inputs: IsolationProbeInputs): RunnerIsolationRecord {
  const { host } = inputs;
  let claude: BackendConfinement;
  let codex: BackendConfinement;

  if (inputs.optOut) {
    claude = codex = none('opt_out');
  } else if (host.platform === 'darwin') {
    if (inputs.seatbelt) {
      claude = { mechanism: 'seatbelt', scope: CONFINED_SCOPE };
      codex = { mechanism: 'seatbelt', scope: CODEX_SCOPE };
    } else {
      claude = codex = none('backend_probe_failed');
    }
  } else if (host.platform === 'windows') {
    claude = none('unsupported_platform');
    codex = inputs.codexWindows
      ? { mechanism: 'windows_restricted_token', scope: CODEX_WINDOWS_SCOPE }
      : none('backend_probe_failed');
  } else if (host.platform === 'other') {
    claude = codex = none('unsupported_platform');
  } else if (inputs.bwrap?.ok) {
    claude = { mechanism: 'bwrap', scope: CONFINED_SCOPE };
    codex = { mechanism: 'bwrap', scope: CODEX_SCOPE };
  } else {
    claude = codex = none(inputs.bwrap ? inputs.bwrap.reason : 'probe_exec_failed');
  }

  const codexModes: Record<CodexSandboxMode, BackendConfinement> = {
    'read-only': { ...codex, scope: [...codex.scope] },
    'workspace-write': { ...codex, scope: [...codex.scope] },
  };
  if (!inputs.optOut && host.platform === 'windows' && inputs.codexWindowsModes) {
    for (const mode of ['read-only', 'workspace-write'] as const) {
      const implementation = inputs.codexWindowsModes[mode];
      codexModes[mode] = implementation && inputs.codexWindowsBinary
        ? { mechanism: implementation === 'mxc' ? 'windows_mxc' : 'windows_restricted_token',
            scope: [...CODEX_WINDOWS_SCOPE], windowsSandbox: { implementation, binary: inputs.codexWindowsBinary } }
        : none('backend_probe_failed');
    }
  }
  return {
    platform: host.platform,
    evidence: host.evidence,
    claude,
    codex: codexModes,
    probeAt: inputs.probeAt,
    processStartedAt: inputs.processStartedAt,
    runnerVersion: inputs.runnerVersion,
    reducedOptIn: inputs.reducedOptIn === true,
  };
}

/** Whether a backend has any confinement to apply in a mode. */
export function isConfined(confinement: BackendConfinement): boolean {
  return confinement.mechanism !== 'none';
}

/**
 * The Claude session's sandbox option and env-scrub decision, from the Claude
 * record alone (R-6, AC-6): on darwin Seatbelt confines Claude, so the
 * workspace's sandbox config and the env scrub stay as configured whatever
 * bwrap would say. Only a host with no confinement for Claude forces the
 * sandbox off, so the CLI doesn't fail every Bash call trying to start it.
 */
export function claudeSessionSandbox<T extends { enabled?: boolean }>(
  claude: BackendConfinement,
  configured: T | undefined,
): { sandbox: T | { enabled: false } | undefined; disableEnvScrub: boolean } {
  if (!isConfined(claude)) return { sandbox: { enabled: false }, disableEnvScrub: true };
  return { sandbox: configured?.enabled ? configured : undefined, disableEnvScrub: false };
}

/** The host checks behind a record, injectable so every surface reads one fixture. */
export interface IsolationProbes {
  host(): { platform: RunnerHostPlatform; evidence: string[] };
  /** BUILDD_DISABLE_SANDBOX=1. */
  optOut(): boolean;
  /** Claude's inner-sandbox bwrap probe, with the cause when it fails. */
  bwrap(): BwrapProbeResult;
  /** The darwin Seatbelt probe. */
  seatbelt(): boolean;
  /** The Windows Codex sandbox probe; absent reads as not confined. */
  codexWindows?(): boolean;
  codexWindowsModes?(): { modes: WindowsSandboxModes; binary: string | null };
  /** The operator's reduced-confinement opt-in (R-5); absent reads as not opted in. */
  reducedOptIn?(): boolean;
}

/** The probes, run for real and uncached. The runtime caches its own (workers.ts). */
export const realIsolationProbes: IsolationProbes = {
  host: () => detectHostPlatform(),
  optOut: () => process.env.BUILDD_DISABLE_SANDBOX === '1',
  bwrap: () => probeBwrapNamespacesDetailed(CLAUDE_INNER_SANDBOX_UNSHARE, true),
  seatbelt: probeSeatbelt,
  codexWindowsModes: () => {
    const binary = resolveCodexBinary();
    return { binary, modes: probeCodexWindowsModes({ codexBin: () => binary, run: runInCodexSandbox, probeRoot: resolveBuilddHome }) };
  },
  reducedOptIn: () => reducedIsolationOptedIn(process.env),
};

/**
 * R-8: the one capability function. The runtime (workers.ts getIsolationRecord,
 * whose record the heartbeat carries), `buildd doctor` and install.sh (through
 * isolation-check.ts) all build their record here, so one host gets one
 * verdict. Runs only the probe the host needs: Seatbelt on darwin, bwrap on
 * Linux, Codex's sandbox on Windows, none on an opt-out or an unsupported
 * platform. Probes only: nothing
 * here changes a host setting.
 */
export function probeIsolationRecord(
  probes: IsolationProbes,
  meta: Pick<IsolationProbeInputs, 'processStartedAt' | 'runnerVersion'> & { probeAt?: () => string },
): RunnerIsolationRecord {
  const host = probes.host();
  const optOut = probes.optOut();
  let bwrap: BwrapProbeResult | null = null;
  let seatbelt: boolean | null = null;
  let codexWindows: boolean | null = null;
  let windows: { modes: WindowsSandboxModes; binary: string | null } | undefined;
  if (!optOut && host.platform === 'darwin') seatbelt = probes.seatbelt();
  else if (!optOut && host.platform === 'windows') {
    if (probes.codexWindowsModes) windows = probes.codexWindowsModes();
    else codexWindows = probes.codexWindows?.() ?? false;
  }
  else if (!optOut && host.platform !== 'other') bwrap = probes.bwrap();
  return buildIsolationRecord({
    host,
    optOut,
    bwrap,
    seatbelt,
    codexWindows,
    codexWindowsModes: windows?.modes,
    codexWindowsBinary: windows?.binary,
    probeAt: meta.probeAt?.() ?? new Date().toISOString(),
    processStartedAt: meta.processStartedAt,
    runnerVersion: meta.runnerVersion,
    reducedOptIn: probes.reducedOptIn?.() ?? false,
  });
}

/** When this process started, the R-11 lower bound for its own probe. */
export function processStartedAt(): string {
  return new Date(Date.now() - process.uptime() * 1000).toISOString();
}

const MECHANISM_WORDS: Record<BackendConfinement['mechanism'], string> = {
  seatbelt: 'macOS Seatbelt',
  bwrap: 'bubblewrap',
  landlock: 'Landlock',
  windows_restricted_token: "Codex's Windows sandbox (writes only)",
  windows_mxc: "Codex's Windows MXC sandbox (writes only)",
  none: 'nothing',
};

/**
 * The milestone a run records for the mode it starts under (R-5: the task's
 * events say the effective mode). One line, readable on the task timeline.
 */
export function isolationModeLabel(
  decision: Extract<TaskIsolationDecision, { ok: true }>,
  backend: IsolationBackend,
  platform: RunnerHostPlatform,
): string {
  const who = backend === 'claude' ? 'Claude' : 'Codex';
  if (decision.mode === 'enforced') {
    return `isolation: ${decision.requirement}, ${who} confined by ${MECHANISM_WORDS[decision.confinement.mechanism]}`;
  }
  const cause = decision.confinement.reason ? isolationReasonText(decision.confinement.reason, platform) : 'no confinement on this host';
  return `isolation: ${decision.requirement}, ${who} runs REDUCED (unconfined: ${cause}); the runner operator opted in`;
}

/**
 * R-7: may a run whose confinement failed mid-run (bwrap_namespace_denied)
 * restart with less? Re-decided against the record as it now stands, which
 * already shows the denial: a protected task never may; a trusted_local one
 * may only with the operator's opt-in, and the restart is a recorded
 * degradation. `error` is the attempt's failure when it may not.
 */
export function decideConfinementRestart(
  decision: TaskIsolationDecision,
  backend: IsolationBackend,
): { restart: true; label: string } | { restart: false; error: string } {
  const who = backend === 'claude' ? 'Claude' : 'Codex';
  if (decision.ok && decision.mode === 'reduced') {
    return { restart: true, label: `isolation degraded: ${who}'s sandbox failed mid-run; restarting this trusted_local task unconfined (operator opt-in)` };
  }
  const why = decision.ok
    ? `the runner still reports confinement for ${who}, so the failure is not one a reduced restart should paper over`
    : `${decision.message}${decision.remedy.length > 0 ? ` ${decision.remedy.join(' ')}` : ''}`;
  return {
    restart: false,
    error: `${who}'s sandbox failed mid-run (bubblewrap could not create namespaces) and this ${decision.requirement} task is not restarted with less confinement: ${why}`,
  };
}
