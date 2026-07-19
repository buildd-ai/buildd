/**
 * Environment verifier — `buildd env verify`.
 *
 * Proves a repo is *runnable* before an agent (or a human, or CI) spends time on
 * it. See docs/design/reliable-env-provisioning.md for the why.
 *
 * A repo declares how to become runnable in `.buildd/env.yaml`:
 *
 *   toolchain:
 *     runtime: bun@1.3.14
 *   install:
 *     command: bun install --frozen-lockfile
 *   env:
 *     required: [DATABASE_URL, VOYAGE_API_KEY]
 *   readiness:
 *     command: bun run scripts/check-specs.ts --check
 *     timeout: 180
 *   provision:
 *     - git config core.hooksPath .githooks
 *
 * When no manifest is present we auto-detect a sensible plan from lockfiles so
 * existing repos get value with zero config.
 *
 * The module is split into a PURE half (parse / auto-detect / plan) that is
 * trivially unit-testable, and an EXECUTION half (run the planned steps) whose
 * command runner is injectable so tests never shell out.
 */

import { exec } from 'child_process';
import { promisify } from 'util';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

const pexec = promisify(exec);

// ─── Manifest shape ──────────────────────────────────────────────────────────

export interface EnvManifest {
  toolchain?: { runtime?: string };
  install?: { command?: string };
  env?: { required?: string[] };
  readiness?: { command?: string; timeout?: number };
  provision?: string[];
}

export const MANIFEST_PATH = '.buildd/env.yaml';

const DEFAULT_INSTALL_TIMEOUT_MS = 300_000;
const DEFAULT_READINESS_TIMEOUT_MS = 180_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

// ─── Parsing (pure) ──────────────────────────────────────────────────────────

/**
 * Parse a `.buildd/env.yaml` document into a normalized manifest. Tolerant by
 * design: unknown keys are ignored, and a malformed doc yields `null` rather
 * than throwing, so a bad manifest degrades to "no manifest" (auto-detect)
 * instead of hard-crashing the runner mid-provision.
 */
export function parseManifest(raw: string): EnvManifest | null {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(raw);
  } catch {
    return null;
  }
  if (!doc || typeof doc !== 'object') return null;
  const d = doc as Record<string, any>;

  const asStringArray = (v: unknown): string[] | undefined =>
    Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim()) : undefined;

  const m: EnvManifest = {};
  if (d.toolchain && typeof d.toolchain.runtime === 'string')
    m.toolchain = { runtime: d.toolchain.runtime.trim() };
  if (d.install && typeof d.install.command === 'string')
    m.install = { command: d.install.command.trim() };
  if (d.env) {
    const required = asStringArray(d.env.required);
    if (required) m.env = { required };
  }
  if (d.readiness && typeof d.readiness.command === 'string') {
    m.readiness = { command: d.readiness.command.trim() };
    if (typeof d.readiness.timeout === 'number') m.readiness.timeout = d.readiness.timeout;
  }
  const provision = asStringArray(d.provision);
  if (provision) m.provision = provision;

  return m;
}

// ─── Auto-detection (pure) ───────────────────────────────────────────────────

/**
 * A lockfile → toolchain+install mapping. First match wins, so keep the most
 * specific / deterministic ecosystems first. This is deliberately conservative:
 * it only claims a plan when a lockfile makes the install deterministic.
 */
const DETECTORS: Array<{
  lockfile: string;
  runtime: string;
  install: string;
}> = [
  { lockfile: 'bun.lock', runtime: 'bun', install: 'bun install --frozen-lockfile' },
  { lockfile: 'bun.lockb', runtime: 'bun', install: 'bun install --frozen-lockfile' },
  { lockfile: 'pnpm-lock.yaml', runtime: 'pnpm', install: 'pnpm install --frozen-lockfile' },
  { lockfile: 'yarn.lock', runtime: 'yarn', install: 'yarn install --frozen-lockfile' },
  { lockfile: 'package-lock.json', runtime: 'node', install: 'npm ci' },
  { lockfile: 'uv.lock', runtime: 'uv', install: 'uv sync --frozen' },
  { lockfile: 'poetry.lock', runtime: 'python3', install: 'poetry install' },
  { lockfile: 'Cargo.lock', runtime: 'cargo', install: 'cargo fetch --locked' },
  { lockfile: 'go.sum', runtime: 'go', install: 'go mod download' },
];

/**
 * Best-effort manifest for a repo that hasn't declared one. Returns `null` when
 * nothing recognizable is found — the caller reports that honestly rather than
 * pretending an empty plan "passed".
 */
export function autoDetectManifest(
  root: string,
  fileExists: (p: string) => boolean = (p) => existsSync(join(root, p)),
): EnvManifest | null {
  for (const d of DETECTORS) {
    if (fileExists(d.lockfile)) {
      return { toolchain: { runtime: d.runtime }, install: { command: d.install } };
    }
  }
  return null;
}

export interface ResolvedManifest {
  manifest: EnvManifest | null;
  /** Where the plan came from — surfaced in output so a green run isn't mistaken for a declared contract. */
  source: 'manifest' | 'auto-detected' | 'none';
}

/**
 * Filesystem probe — injectable so callers (and tests) don't depend on the real
 * `fs`. Paths are relative to the repo root. Defaults to the real filesystem.
 */
export interface FsProbe {
  exists: (relPath: string) => boolean;
  read: (relPath: string) => string;
}

function realFsProbe(root: string): FsProbe {
  return {
    exists: (rel) => existsSync(join(root, rel)),
    read: (rel) => readFileSync(join(root, rel), 'utf-8'),
  };
}

/** Load the declared manifest, else auto-detect, else nothing. */
export function resolveManifest(root: string, fs: FsProbe = realFsProbe(root)): ResolvedManifest {
  if (fs.exists(MANIFEST_PATH)) {
    const parsed = parseManifest(fs.read(MANIFEST_PATH));
    if (parsed) return { manifest: parsed, source: 'manifest' };
    // Malformed manifest: fall through to auto-detect but say so via 'none' vs 'auto'.
  }
  const auto = autoDetectManifest(root, fs.exists);
  if (auto) return { manifest: auto, source: 'auto-detected' };
  return { manifest: null, source: 'none' };
}

// ─── Step planning (pure) ────────────────────────────────────────────────────

export type PhaseKind = 'toolchain' | 'install' | 'env' | 'provision' | 'readiness';

export interface Step {
  phase: PhaseKind;
  label: string;
  kind: 'tool-check' | 'command' | 'env-check';
  /** for kind==='command' */
  command?: string;
  /** for kind==='tool-check' */
  tool?: string;
  /** for kind==='env-check' */
  vars?: string[];
  timeoutMs?: number;
}

/** `bun@1.3.14` → { tool: 'bun', version: '1.3.14' }; bare `node` → { tool: 'node' }. */
export function parseRuntime(runtime: string): { tool: string; version?: string } {
  const [tool, version] = runtime.split('@');
  return version ? { tool: tool.trim(), version: version.trim() } : { tool: tool.trim() };
}

/**
 * Turn a manifest into an ordered list of verification steps. Order matters:
 * toolchain → install → env → provision → readiness, so a failure blames the
 * earliest, most actionable cause (missing runtime before failing readiness).
 */
export function planSteps(manifest: EnvManifest): Step[] {
  const steps: Step[] = [];

  if (manifest.toolchain?.runtime) {
    const { tool, version } = parseRuntime(manifest.toolchain.runtime);
    steps.push({
      phase: 'toolchain',
      label: version ? `${tool} (want ${version})` : tool,
      kind: 'tool-check',
      tool,
    });
  }

  if (manifest.install?.command) {
    steps.push({
      phase: 'install',
      label: manifest.install.command,
      kind: 'command',
      command: manifest.install.command,
      timeoutMs: DEFAULT_INSTALL_TIMEOUT_MS,
    });
  }

  if (manifest.env?.required?.length) {
    steps.push({
      phase: 'env',
      label: `required: ${manifest.env.required.join(', ')}`,
      kind: 'env-check',
      vars: manifest.env.required,
    });
  }

  for (const cmd of manifest.provision ?? []) {
    steps.push({
      phase: 'provision',
      label: cmd,
      kind: 'command',
      command: cmd,
      timeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    });
  }

  if (manifest.readiness?.command) {
    const timeoutSec = manifest.readiness.timeout;
    steps.push({
      phase: 'readiness',
      label: manifest.readiness.command,
      kind: 'command',
      command: manifest.readiness.command,
      timeoutMs: (timeoutSec ? timeoutSec * 1000 : DEFAULT_READINESS_TIMEOUT_MS),
    });
  }

  return steps;
}

// ─── Execution ───────────────────────────────────────────────────────────────

export type StepStatus = 'ok' | 'fail' | 'skip';

export interface StepResult {
  phase: PhaseKind;
  label: string;
  status: StepStatus;
  message: string;
  durationMs?: number;
}

export interface VerifyReport {
  source: ResolvedManifest['source'];
  steps: StepResult[];
  ok: boolean;
}

export interface CommandOutcome {
  code: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  opts: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => CommandOutcome | Promise<CommandOutcome>;

export interface ExecuteOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  /**
   * Phases to skip (their steps report `skip` and neither run nor fail). The
   * runner passes `['install']` because it already ran its own tolerant install
   * (installWorkspaceDeps) — re-running a frozen install here would falsely fail
   * on lockfile drift the runner deliberately tolerates. Readiness still proves
   * the tree is usable.
   */
  skipPhases?: PhaseKind[];
  /** Filesystem probe injection for tests; defaults to the real fs at `root`. */
  fs?: FsProbe;
  /**
   * Base commit SHA of the tree being verified. When set (and the manifest is
   * env-independent), enables the warm gate cache — a pass is reused for repeat
   * provisions off the same base on this runner. Omit to always run fresh.
   */
  commit?: string;
  /** Monotonic clock injection for tests; defaults to wall clock. */
  now?: () => number;
}

// Async so a slow readiness probe (tsc, lint) never blocks the runner's single
// event loop while other workers are streaming. `exec` runs the command through
// a shell (the manifest declares shell strings) and captures both streams.
const defaultRunCommand: CommandRunner = async (command, opts) => {
  try {
    const { stdout, stderr } = await pexec(command, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      encoding: 'utf-8',
      env: opts.env,
    });
    return { code: 0, stdout: stdout ?? '', stderr: stderr ?? '' };
  } catch (err: any) {
    return {
      code: typeof err?.code === 'number' ? err.code : 1,
      stdout: err?.stdout?.toString?.() ?? '',
      stderr: err?.stderr?.toString?.() ?? err?.message ?? String(err),
    };
  }
};

/** One-line diagnosis from a failed command's streams, trimmed for the report. */
function failMessage(out: CommandOutcome): string {
  const stream = (out.stderr || out.stdout || '').trim();
  const lastLine = stream.split('\n').filter(Boolean).pop() ?? '';
  const detail = lastLine.slice(0, 200);
  return detail ? `exit ${out.code}: ${detail}` : `exit ${out.code}`;
}

/**
 * Execute planned steps in order, stopping at the first failure (later phases
 * assume earlier ones passed — running install before the runtime exists is
 * noise). Returns a structured report; never throws.
 */
export async function executeSteps(steps: Step[], opts: ExecuteOptions): Promise<StepResult[]> {
  const env = opts.env ?? process.env;
  const run = opts.runCommand ?? defaultRunCommand;
  const now = opts.now ?? (() => Date.now());
  const skip = new Set(opts.skipPhases ?? []);
  const results: StepResult[] = [];
  let aborted = false;

  for (const step of steps) {
    if (skip.has(step.phase)) {
      results.push({ phase: step.phase, label: step.label, status: 'skip', message: 'skipped (handled by runner)' });
      continue;
    }
    if (aborted) {
      results.push({ phase: step.phase, label: step.label, status: 'skip', message: 'skipped (earlier phase failed)' });
      continue;
    }

    const start = now();
    let result: StepResult;

    if (step.kind === 'env-check') {
      const missing = (step.vars ?? []).filter((v) => !env[v] || env[v] === '');
      result = missing.length
        ? { phase: step.phase, label: step.label, status: 'fail', message: `missing: ${missing.join(', ')}` }
        : { phase: step.phase, label: step.label, status: 'ok', message: 'all required vars present' };
    } else if (step.kind === 'tool-check') {
      const out = await run(`command -v ${step.tool}`, { cwd: opts.root, timeoutMs: 10_000, env });
      result = out.code === 0
        ? { phase: step.phase, label: step.label, status: 'ok', message: 'found' }
        : { phase: step.phase, label: step.label, status: 'fail', message: `\`${step.tool}\` not on PATH` };
    } else {
      const out = await run(step.command!, { cwd: opts.root, timeoutMs: step.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, env });
      result = out.code === 0
        ? { phase: step.phase, label: step.label, status: 'ok', message: 'ok' }
        : { phase: step.phase, label: step.label, status: 'fail', message: failMessage(out) };
    }

    result.durationMs = now() - start;
    if (result.status === 'fail') aborted = true;
    results.push(result);
  }

  return results;
}

/**
 * Top-level entry: resolve the manifest, plan, execute, and report. This is what
 * the CLI calls (and what the provision gate builds on).
 */
export async function runEnvVerify(opts: ExecuteOptions): Promise<VerifyReport> {
  const { manifest, source } = resolveManifest(opts.root, opts.fs);
  if (!manifest) {
    return { source, steps: [], ok: true };
  }
  const steps = await executeSteps(planSteps(manifest), opts);
  const ok = steps.every((s) => s.status !== 'fail');
  return { source, steps, ok };
}

// ─── Provision gate (runner integration) ─────────────────────────────────────

export interface ProvisionGateResult {
  source: ResolvedManifest['source'];
  /** True only when the repo DECLARED a manifest — the only case that blocks. */
  enforced: boolean;
  /** Passed, or nothing to enforce. When false AND enforced, block the agent. */
  ok: boolean;
  steps: StepResult[];
  /** Human-readable failure reason for the worker record, set when blocking. */
  reason?: string;
  /**
   * Stable, machine-readable failure classification, set when blocking. Lets the
   * server/organizer act on the KIND of failure (e.g. an env-missing is likely a
   * missing secret to escalate, a readiness fail may be worth one retry) instead
   * of regex-matching a free-text string. See docs/design/reliable-env-provisioning.md.
   */
  failure?: ProvisionFailure;
  /** True when this PASS was served from the warm cache (no steps re-run). */
  cached?: boolean;
}

/** Stable reason codes — one per phase. The server keys requeue/escalate policy off these. */
export type ProvisionFailureCode =
  | 'provision_toolchain_missing'
  | 'provision_install_failed'
  | 'provision_env_missing'
  | 'provision_setup_failed'
  | 'provision_readiness_failed';

export interface ProvisionFailure {
  code: ProvisionFailureCode;
  phase: PhaseKind;
  message: string;
}

const PHASE_FAILURE_CODE: Record<PhaseKind, ProvisionFailureCode> = {
  toolchain: 'provision_toolchain_missing',
  install: 'provision_install_failed',
  env: 'provision_env_missing',
  provision: 'provision_setup_failed',
  readiness: 'provision_readiness_failed',
};

/** `Provision failed [readiness]: exit 1: <detail>` — a diagnosable worker error. */
function provisionReason(step: StepResult): string {
  return `Provision failed [${step.phase}]: ${step.message}`;
}

function provisionFailure(step: StepResult): ProvisionFailure {
  return { code: PHASE_FAILURE_CODE[step.phase], phase: step.phase, message: step.message };
}

// ─── Warm gate cache ─────────────────────────────────────────────────────────
// The gate runs BEFORE the agent modifies the worktree, so at gate time the tree
// is exactly the base commit. For an env-INDEPENDENT manifest (no env.required)
// the pass is therefore a pure function of (base commit + manifest) — identical
// across every task branching off that base. On a single runner that's a real
// win: skip a possibly-expensive readiness probe (e.g. tsc) for repeat tasks.
//
// Safety: only PASSES are cached (a failure may be fixed → always re-check), only
// for manifests with no env.required (env can't change the result), keyed by the
// caller-supplied commit + a manifest hash, with a short TTL to bound staleness
// (e.g. a runner-level toolchain change). Manifests with env.required are never
// cached — their result depends on per-task injected secrets.

const GATE_CACHE_TTL_MS = 10 * 60 * 1000;
const gateCache = new Map<string, number>(); // key → timestamp of the cached pass

/** Test seam: drop all warm-cache entries. */
export function clearProvisionGateCache(): void {
  gateCache.clear();
}

/** FNV-1a over the manifest JSON — a stable, dependency-free cache discriminator. */
function manifestHash(manifest: EnvManifest): string {
  const s = JSON.stringify(manifest);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16);
}

/**
 * The runner's readiness gate: prove a claimed task's environment is runnable
 * before the agent starts consuming budget. Enforcement is OPT-IN — only a
 * declared `.buildd/env.yaml` blocks. Auto-detected plans (no manifest) never
 * fail a runner that didn't opt in; they remain a CLI/CI convenience.
 *
 * When `opts.commit` is supplied and the manifest is env-independent, a passing
 * result is cached and reused for repeat provisions off the same base (see the
 * warm-cache note above). See docs/design/reliable-env-provisioning.md.
 */
export async function runProvisionGate(opts: ExecuteOptions): Promise<ProvisionGateResult> {
  const { manifest, source } = resolveManifest(opts.root, opts.fs);
  if (source !== 'manifest' || !manifest) {
    return { source, enforced: false, ok: true, steps: [] };
  }

  const now = opts.now ?? (() => Date.now());
  // Cacheable only when the caller pins a base commit AND the gate is
  // env-independent (env.required would make the result depend on per-task secrets).
  const cacheable = !!opts.commit && !manifest.env?.required?.length;
  const cacheKey = cacheable ? `${opts.commit}\0${manifestHash(manifest)}` : null;
  if (cacheKey) {
    const at = gateCache.get(cacheKey);
    if (at !== undefined && now() - at < GATE_CACHE_TTL_MS) {
      return { source, enforced: true, ok: true, steps: [], cached: true };
    }
  }

  const steps = await executeSteps(planSteps(manifest), opts);
  const firstFail = steps.find((s) => s.status === 'fail');
  const ok = !firstFail;
  if (cacheKey && ok) gateCache.set(cacheKey, now());

  return {
    source,
    enforced: true,
    ok,
    steps,
    reason: firstFail ? provisionReason(firstFail) : undefined,
    failure: firstFail ? provisionFailure(firstFail) : undefined,
  };
}

// ─── Reporting ───────────────────────────────────────────────────────────────

const C = {
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m',
  dim: '\x1b[2m', bold: '\x1b[1m', reset: '\x1b[0m',
};

function icon(s: StepStatus): string {
  return s === 'ok' ? `${C.green}✓${C.reset}` : s === 'skip' ? `${C.dim}∅${C.reset}` : `${C.red}✗${C.reset}`;
}

/** Human-readable report for the CLI. */
export function formatReport(report: VerifyReport): string {
  const lines: string[] = [];
  lines.push('');
  lines.push(`${C.bold}buildd env verify${C.reset}  ${C.dim}(${report.source})${C.reset}`);

  if (report.source === 'none') {
    lines.push('');
    lines.push(`  ${C.yellow}!${C.reset} no ${MANIFEST_PATH} and no recognizable lockfile — nothing to verify`);
    lines.push(`  ${C.dim}Declare one at ${MANIFEST_PATH} to enforce a readiness gate.${C.reset}`);
    lines.push('');
    return lines.join('\n');
  }

  lines.push('');
  for (const s of report.steps) {
    const dur = s.durationMs != null ? ` ${C.dim}${s.durationMs}ms${C.reset}` : '';
    lines.push(`  ${icon(s.status)} ${C.dim}[${s.phase}]${C.reset} ${s.label}  ${C.dim}${s.message}${C.reset}${dur}`);
  }
  lines.push('');
  lines.push(
    report.ok
      ? `  ${C.green}environment verified${C.reset}`
      : `  ${C.red}environment NOT ready${C.reset} — fix the ✗ above before running`,
  );
  lines.push('');
  return lines.join('\n');
}

/** Machine-readable report for CI / the runner provision phase. */
export function reportToJson(report: VerifyReport): string {
  return JSON.stringify(report, null, 2);
}
