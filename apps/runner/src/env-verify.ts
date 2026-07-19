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

import { execSync } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';

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

/** Load the declared manifest, else auto-detect, else nothing. */
export function resolveManifest(root: string): ResolvedManifest {
  const manifestFile = join(root, MANIFEST_PATH);
  if (existsSync(manifestFile)) {
    const parsed = parseManifest(readFileSync(manifestFile, 'utf-8'));
    if (parsed) return { manifest: parsed, source: 'manifest' };
    // Malformed manifest: fall through to auto-detect but say so via 'none' vs 'auto'.
  }
  const auto = autoDetectManifest(root);
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
) => CommandOutcome;

export interface ExecuteOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  runCommand?: CommandRunner;
  /** Monotonic clock injection for tests; defaults to wall clock. */
  now?: () => number;
}

const defaultRunCommand: CommandRunner = (command, opts) => {
  try {
    const stdout = execSync(command, {
      cwd: opts.cwd,
      timeout: opts.timeoutMs,
      encoding: 'utf-8',
      stdio: 'pipe',
      env: opts.env,
    });
    return { code: 0, stdout, stderr: '' };
  } catch (err: any) {
    return {
      code: typeof err?.status === 'number' ? err.status : 1,
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
export function executeSteps(steps: Step[], opts: ExecuteOptions): StepResult[] {
  const env = opts.env ?? process.env;
  const run = opts.runCommand ?? defaultRunCommand;
  const now = opts.now ?? (() => Date.now());
  const results: StepResult[] = [];
  let aborted = false;

  for (const step of steps) {
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
      const out = run(`command -v ${step.tool}`, { cwd: opts.root, timeoutMs: 10_000, env });
      result = out.code === 0
        ? { phase: step.phase, label: step.label, status: 'ok', message: 'found' }
        : { phase: step.phase, label: step.label, status: 'fail', message: `\`${step.tool}\` not on PATH` };
    } else {
      const out = run(step.command!, { cwd: opts.root, timeoutMs: step.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, env });
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
 * the CLI and the runner's provision phase both call.
 */
export function runEnvVerify(opts: ExecuteOptions): VerifyReport {
  const { manifest, source } = resolveManifest(opts.root);
  if (!manifest) {
    return { source, steps: [], ok: true };
  }
  const steps = executeSteps(planSteps(manifest), opts);
  const ok = steps.every((s) => s.status !== 'fail');
  return { source, steps, ok };
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
