/**
 * Ecosystem / lockfile detection — pure, no fs, no fetch, no clock.
 *
 * One table of "which files mean which toolchain", shared by the runner's env
 * verifier (`apps/runner/src/env-verify.ts`) and anything that has to reason about
 * a repo it cannot touch (web routes reading a git tree). Input is a flat list of
 * repo-relative paths plus an optional map of small manifest contents; output is
 * the detected ecosystems with install/test/typecheck/build command *candidates*.
 *
 * Generic by construction: nothing here assumes a particular repo's layout or a
 * preferred package manager. A bare `package.json` is npm, not bun.
 * Detection is root-only; callers that walk subdirectories probe each directory
 * themselves (see `findLockfileRule`).
 */

export type Ecosystem = 'node' | 'python' | 'rust' | 'go';
export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm' | 'uv' | 'poetry' | 'pip' | 'cargo' | 'go';

// ─── Lockfile table ──────────────────────────────────────────────────────────

export interface LockfileRule {
  lockfile: string;
  ecosystem: Ecosystem;
  packageManager: PackageManager;
  /** Tool the install needs on PATH (the env verifier's `toolchain.runtime`). */
  runtime: string;
  /** Deterministic install for this lockfile. */
  install: string;
}

/**
 * A lockfile → toolchain+install mapping. First match wins, so the most
 * specific / deterministic ecosystems come first. Conservative on purpose: it
 * only claims a plan when a lockfile makes the install deterministic.
 */
export const LOCKFILE_RULES: readonly LockfileRule[] = [
  { lockfile: 'bun.lock', ecosystem: 'node', packageManager: 'bun', runtime: 'bun', install: 'bun install --frozen-lockfile' },
  { lockfile: 'bun.lockb', ecosystem: 'node', packageManager: 'bun', runtime: 'bun', install: 'bun install --frozen-lockfile' },
  { lockfile: 'pnpm-lock.yaml', ecosystem: 'node', packageManager: 'pnpm', runtime: 'pnpm', install: 'pnpm install --frozen-lockfile' },
  { lockfile: 'yarn.lock', ecosystem: 'node', packageManager: 'yarn', runtime: 'yarn', install: 'yarn install --frozen-lockfile' },
  { lockfile: 'package-lock.json', ecosystem: 'node', packageManager: 'npm', runtime: 'node', install: 'npm ci' },
  { lockfile: 'uv.lock', ecosystem: 'python', packageManager: 'uv', runtime: 'uv', install: 'uv sync --frozen' },
  { lockfile: 'poetry.lock', ecosystem: 'python', packageManager: 'poetry', runtime: 'python3', install: 'poetry install' },
  { lockfile: 'Cargo.lock', ecosystem: 'rust', packageManager: 'cargo', runtime: 'cargo', install: 'cargo fetch --locked' },
  { lockfile: 'go.sum', ecosystem: 'go', packageManager: 'go', runtime: 'go', install: 'go mod download' },
];

/** The first rule whose lockfile `exists` (repo-relative name), or null. */
export function findLockfileRule(exists: (lockfile: string) => boolean): LockfileRule | null {
  return LOCKFILE_RULES.find((r) => exists(r.lockfile)) ?? null;
}

// ─── Detection ───────────────────────────────────────────────────────────────

export interface CommandCandidate {
  command: string;
  /** `lockfile`: decided by a lockfile; `manifest`: read from a manifest; `convention`: the ecosystem's standard command. */
  source: 'lockfile' | 'manifest' | 'convention';
  confidence: 'high' | 'low';
}

export interface DetectedEcosystem {
  ecosystem: Ecosystem;
  packageManager: PackageManager;
  /** The lockfile that decided the package manager; null when none exists. */
  lockfile: string | null;
  /** Most preferred first. */
  install: CommandCandidate[];
  test: CommandCandidate[];
  typecheck: CommandCandidate[];
  build: CommandCandidate[];
}

export interface EcosystemDetectInput {
  /** Repo-relative file paths. Only root-level entries are considered. */
  files: readonly string[];
  /** Optional contents of small manifests, keyed by repo-relative path (e.g. `package.json`). */
  manifests?: Readonly<Record<string, string>>;
}

const cand = (
  command: string,
  source: CommandCandidate['source'],
  confidence: CommandCandidate['confidence'],
): CommandCandidate => ({ command, source, confidence });

function normalise(p: string): string {
  return p.replace(/^\.\//, '');
}

const NODE_MANAGERS: ReadonlySet<string> = new Set(['bun', 'pnpm', 'yarn', 'npm']);

function detectNode(has: (p: string) => boolean, manifests: Readonly<Record<string, string>>): DetectedEcosystem | null {
  const rule = LOCKFILE_RULES.find((r) => r.ecosystem === 'node' && has(r.lockfile));
  if (!rule && !has('package.json')) return null;

  let pkg: { scripts?: Record<string, unknown>; packageManager?: unknown } = {};
  try {
    const parsed = manifests['package.json'] ? JSON.parse(manifests['package.json']) : {};
    if (parsed && typeof parsed === 'object') pkg = parsed;
  } catch {
    // malformed manifest: treat as absent
  }

  let pm: PackageManager = 'npm';
  let install: CommandCandidate;
  if (rule) {
    pm = rule.packageManager;
    install = cand(rule.install, 'lockfile', 'high');
  } else {
    const declared = typeof pkg.packageManager === 'string' ? pkg.packageManager.split('@')[0] : '';
    if (NODE_MANAGERS.has(declared)) pm = declared as PackageManager;
    install = cand(`${pm} install`, 'manifest', 'low');
  }

  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? pkg.scripts : {};
  const fromScripts = (names: string[]): CommandCandidate[] =>
    names.filter((n) => typeof scripts[n] === 'string').map((n) => cand(`${pm} run ${n}`, 'manifest', 'high'));

  return {
    ecosystem: 'node',
    packageManager: pm,
    lockfile: rule?.lockfile ?? null,
    install: [install],
    test: fromScripts(['test']),
    typecheck: fromScripts(['typecheck', 'check-types', 'type-check', 'tsc']),
    build: fromScripts(['build']),
  };
}

function detectPython(has: (p: string) => boolean, manifests: Readonly<Record<string, string>>): DetectedEcosystem | null {
  const rule = LOCKFILE_RULES.find((r) => r.ecosystem === 'python' && has(r.lockfile));
  const hasPyproject = has('pyproject.toml');
  const hasRequirements = has('requirements.txt');
  if (!rule && !hasPyproject && !hasRequirements) return null;

  const pyproject = manifests['pyproject.toml'] ?? '';
  let pm: PackageManager;
  let install: CommandCandidate;
  if (rule) {
    pm = rule.packageManager;
    install = cand(rule.install, 'lockfile', 'high');
  } else if (/^\s*\[tool\.poetry[\].]/m.test(pyproject)) {
    pm = 'poetry';
    install = cand('poetry install', 'manifest', 'low');
  } else if (/^\s*\[tool\.uv[\].]/m.test(pyproject)) {
    pm = 'uv';
    install = cand('uv sync', 'manifest', 'low');
  } else {
    pm = 'pip';
    install = hasPyproject
      ? cand('pip install -e .', 'manifest', 'low')
      : cand('pip install -r requirements.txt', 'manifest', 'low');
  }

  const wrap = (cmd: string): string => (pm === 'uv' ? `uv run ${cmd}` : pm === 'poetry' ? `poetry run ${cmd}` : cmd);

  const pytest = has('pytest.ini') || /^\s*\[tool\.pytest[\].]/m.test(pyproject);
  const mypy = has('mypy.ini') || /^\s*\[tool\.mypy[\].]/m.test(pyproject);
  const pyright = has('pyrightconfig.json') || /^\s*\[tool\.pyright[\].]/m.test(pyproject);

  return {
    ecosystem: 'python',
    packageManager: pm,
    lockfile: rule?.lockfile ?? null,
    install: [install],
    test: pytest ? [cand(wrap('pytest'), 'manifest', 'high')] : [],
    typecheck: mypy
      ? [cand(wrap('mypy .'), 'manifest', 'high')]
      : pyright
        ? [cand(wrap('pyright'), 'manifest', 'high')]
        : [],
    build: [],
  };
}

function detectRust(has: (p: string) => boolean): DetectedEcosystem | null {
  const rule = LOCKFILE_RULES.find((r) => r.ecosystem === 'rust' && has(r.lockfile));
  if (!rule && !has('Cargo.toml')) return null;
  return {
    ecosystem: 'rust',
    packageManager: 'cargo',
    lockfile: rule?.lockfile ?? null,
    install: [rule ? cand(rule.install, 'lockfile', 'high') : cand('cargo fetch', 'manifest', 'low')],
    test: [cand('cargo test', 'convention', 'high')],
    typecheck: [cand('cargo check', 'convention', 'high')],
    build: [cand('cargo build', 'convention', 'high')],
  };
}

function detectGo(has: (p: string) => boolean): DetectedEcosystem | null {
  const rule = LOCKFILE_RULES.find((r) => r.ecosystem === 'go' && has(r.lockfile));
  if (!rule && !has('go.mod')) return null;
  return {
    ecosystem: 'go',
    packageManager: 'go',
    lockfile: rule?.lockfile ?? null,
    install: [rule ? cand(rule.install, 'lockfile', 'high') : cand('go mod download', 'manifest', 'low')],
    test: [cand('go test ./...', 'convention', 'high')],
    typecheck: [cand('go vet ./...', 'convention', 'high')],
    build: [cand('go build ./...', 'convention', 'high')],
  };
}

/**
 * Every ecosystem recognisable at the repo root, in table order (node, python,
 * rust, go). Empty when nothing is recognised — callers report that honestly
 * rather than treating it as a pass.
 */
export function detectEcosystems(input: EcosystemDetectInput): DetectedEcosystem[] {
  const present = new Set(input.files.map(normalise));
  const has = (p: string) => present.has(p);
  const manifests = input.manifests ?? {};
  return [
    detectNode(has, manifests),
    detectPython(has, manifests),
    detectRust(has),
    detectGo(has),
  ].filter((e): e is DetectedEcosystem => e !== null);
}
