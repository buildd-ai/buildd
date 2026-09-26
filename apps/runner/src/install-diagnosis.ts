/**
 * Human-facing diagnosis of a failed worktree dependency install.
 *
 * Pure and dependency-free on purpose: `git-operations` is mocked wholesale by
 * many runner tests, so helpers that workers.ts calls live here instead, where
 * a module mock cannot make them vanish.
 */

/**
 * What a `registry-auth` failure was about, recovered from bun's output and the
 * repo's own registry config. Every field is optional: this is a hint for the
 * task card, and a partial answer beats none.
 */
export interface RegistryAuthDiagnosis {
  /** Registry host that refused, e.g. `npm.pkg.github.com`. Never carries userinfo. */
  host?: string;
  /** Package (or scope) whose fetch was refused, e.g. `@acme/private-lib`. */
  pkg?: string;
  /** Env var the repo's `.npmrc` / `bunfig.toml` reads the token from. */
  envVar?: string;
  /** Config file `envVar` was read from, repo-relative. */
  source?: string;
  /** Whether `envVar` was present in the install's env (never its value). */
  envVarSet?: boolean;
}

/** An install dir as a human reads it: `.` is the repo root, not a stray dot. */
export function formatInstallDir(dir: string): string {
  return dir === '.' || dir === '' ? 'repo root' : dir;
}

const ENV_REF = /\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/;

/**
 * Recover host, package and expected token env var from a registry-auth
 * failure. `readConfig` returns a repo-relative config file's text or null;
 * it is only consulted for `.npmrc` and `bunfig.toml` in the install dir and
 * the repo root. Pure apart from `readConfig`, so it is testable without a
 * filesystem.
 */
export function diagnoseRegistryAuth(
  message: string,
  dir: string,
  readConfig: (rel: string) => string | null,
  env?: Record<string, string | undefined>,
): RegistryAuthDiagnosis {
  const out: RegistryAuthDiagnosis = {};
  // Userinfo (`https://user:token@host`) is matched and dropped, never echoed.
  const url = message.match(/https?:\/\/(?:[^\s/@]+@)?([^\s/:]+)(?::\d+)?(\/[^\s]*)?/i);
  if (url) {
    out.host = url[1].toLowerCase();
    let path = url[2] ?? '';
    try { path = decodeURIComponent(path); } catch { /* keep raw */ }
    const scoped = path.match(/(@[a-z0-9][\w.-]*\/[a-z0-9][\w.-]*)/i);
    if (scoped) out.pkg = scoped[1];
  }
  const scope = out.pkg?.split('/')[0];

  const candidates = [...new Set(
    [dir, '.'].flatMap(d => {
      const base = d === '.' || d === '' ? '' : `${d}/`;
      return [`${base}.npmrc`, `${base}bunfig.toml`];
    }),
  )];
  // Prefer a line naming the refused host, then one naming the scope, then any
  // token-bearing line — a repo with one private registry has one such line.
  let best: { rank: number; envVar: string; source: string } | undefined;
  for (const rel of candidates) {
    let text: string | null = null;
    try { text = readConfig(rel); } catch { text = null; }
    if (!text) continue;
    for (const line of text.split('\n')) {
      if (/^\s*[#;]/.test(line)) continue;
      const ref = line.match(ENV_REF);
      if (!ref) continue;
      if (!/token|auth|password/i.test(line)) continue;
      const rank = out.host && line.toLowerCase().includes(out.host) ? 0
        : scope && line.includes(scope) ? 1
          : 2;
      if (!best || rank < best.rank) best = { rank, envVar: ref[1], source: rel };
    }
  }
  if (best) {
    out.envVar = best.envVar;
    out.source = best.source;
    if (env) out.envVarSet = typeof env[best.envVar] === 'string' && env[best.envVar] !== '';
  }
  return out;
}

/**
 * One line a task card can act on. `registry-auth` names the host, package and
 * the env var the repo's registry config reads, plus where to put it; every
 * other class keeps the short form.
 */
/** The failed-install fields this module reads — structurally a failed `InstallOutcome`. */
export interface FailedInstall {
  dir: string;
  failure: string;
  message: string;
  registry?: RegistryAuthDiagnosis;
}

export function describeInstallFailure(install: FailedInstall): string {
  const head = `Provision failed: dependency install (${install.failure}) at ${formatInstallDir(install.dir)}`;
  if (install.failure !== 'registry-auth') return head;
  const r = install.registry ?? {};
  const what = r.pkg ? `${r.pkg} from ${r.host ?? 'the registry'}` : r.host ?? 'the package registry';
  const parts = [`${head}: ${what} refused the credentials (401/403).`];
  if (r.envVar) {
    parts.push(
      r.envVarSet
        ? `${r.source} reads the token from $${r.envVar}; it was set but rejected — check it is current and can read this package.`
        : `${r.source} reads the token from $${r.envVar}, which was not set for the install.`,
    );
  } else {
    parts.push('No token env var found in the repo\'s .npmrc / bunfig.toml.');
  }
  parts.push(
    `Give the worker ${r.envVar ? `$${r.envVar}` : 'the registry token'} through its role's env (see docs/design/reliable-env-provisioning.md#private-registry-credentials); ` +
    'optionally declare it in .buildd/env.yaml env.required so a missing value fails fast.',
  );
  return parts.join(' ');
}
