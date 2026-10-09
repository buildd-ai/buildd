/**
 * `install.sh --client`: buildd for your own Claude Code / Codex / Cursor
 * sessions without the runner. It checks out only what `buildd login` and
 * `buildd install` load, runs no `bun install`, downloads no Chromium and
 * offers no service.
 *
 * The client file set is derived from the real import graph here, so a new
 * import in login.ts or the installer that the client tree lacks (or that needs
 * an npm package) fails this test instead of a stranger's install. The
 * end-to-end proof is apps/runner/scripts/installer-smoke-client.sh in
 * .github/workflows/installer-smoke.yml.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'fs';
import { builtinModules } from 'module';
import { tmpdir } from 'os';
import { dirname, join, normalize } from 'path';

const repoRoot = join(import.meta.dir, '../../../..');
const installSh = readFileSync(join(import.meta.dir, '../../install.sh'), 'utf8');

const clientBlock = installSh.match(/write_client_sparse_checkout\(\) \{\n  cat > \.git\/info\/sparse-checkout << 'CLIENT_SPARSE'\n([\s\S]*?)\nCLIENT_SPARSE/)?.[1] ?? '';
const clientSparse = clientBlock.split('\n').map(l => l.trim()).filter(Boolean);

/** Local files (repo-relative) and external specifiers reachable from the entry points. */
function importGraph(entries: string[]): { files: string[]; external: string[] } {
  const files = new Set<string>();
  const external = new Set<string>();
  const re = /(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
  const resolveLocal = (from: string, spec: string): string | null => {
    const base = normalize(join(dirname(from), spec));
    for (const c of [base, `${base}.ts`, `${base}.mjs`, `${base}.js`, join(base, 'index.ts')]) {
      if (existsSync(join(repoRoot, c)) && !c.endsWith('/')) {
        try { readFileSync(join(repoRoot, c)); return c; } catch { /* a directory */ }
      }
    }
    return null;
  };
  const walk = (rel: string) => {
    if (files.has(rel)) return;
    files.add(rel);
    const src = readFileSync(join(repoRoot, rel), 'utf8');
    for (const m of src.matchAll(re)) {
      const spec = m[1] ?? m[2] ?? m[3];
      if (spec.startsWith('.')) {
        const r = resolveLocal(rel, spec);
        if (!r) throw new Error(`unresolved ${spec} in ${rel}`);
        walk(r);
      } else external.add(spec);
    }
  };
  for (const e of entries) walk(e);
  return { files: [...files].sort(), external: [...external].sort() };
}

const covered = (file: string) => clientSparse.some(p => (p.endsWith('/') ? file.startsWith(p) : file === p));

const ENTRIES = ['apps/runner/src/login.ts', 'apps/runner/src/agent-plugin-install.ts'];

describe('install.sh --client file set', () => {
  test('the client sparse block exists and is small', () => {
    expect(clientSparse.length).toBeGreaterThan(0);
    expect(clientSparse.some(p => p.startsWith('packages/'))).toBe(false);
    expect(clientSparse).not.toContain('apps/runner/');
  });

  test('every file login and the installer load is checked out in client mode', () => {
    const { files } = importGraph(ENTRIES);
    expect(files).toContain('apps/runner/plugin/scripts/buildd-hook.mjs');
    expect(files.filter(f => !covered(f))).toEqual([]);
  });

  test('they import nothing but runtime built-ins, so client mode needs no bun install', () => {
    const builtins = new Set(builtinModules.flatMap(m => [m, `node:${m}`]));
    const { external } = importGraph(ENTRIES);
    expect(external.filter(s => !builtins.has(s) && !builtins.has(s.split('/')[0]))).toEqual([]);
  });

  test('the plugin ships whole (hooks.json, skills, manifest), and the server-only preload is there for the launcher', () => {
    expect(clientSparse).toContain('apps/runner/plugin/');
    expect(clientSparse).toContain('scripts/stub-server-only.ts');
  });

  test('client mode skips bun install, Chromium and the service prompt, and exits before the runner-only tooling', () => {
    expect(installSh).toContain('[ "$arg" = "--client" ] && CLIENT_MODE=1');
    const guard = installSh.indexOf('if [ "$CLIENT_MODE" != "1" ]; then\n\n# Install dependencies');
    expect(guard).toBeGreaterThan(0);
    const guardEnd = installSh.indexOf('fi # end runner-only: dependencies + Chromium');
    expect(guardEnd).toBeGreaterThan(installSh.indexOf('browser:install --with-deps'));
    const exit = installSh.indexOf('if [ "$CLIENT_MODE" = "1" ]; then\n  finish_client_install\n  exit 0');
    expect(exit).toBeGreaterThan(installSh.indexOf('# --- next steps: end ---'));
    expect(exit).toBeLessThan(installSh.indexOf('if ! zstd_provision; then'));
    expect(exit).toBeLessThan(installSh.indexOf('INSTALL_SERVICE=0'));
  });
});

// ── Bash, run for real against temp HOMEs ─────────────────────────────────────

const homes: string[] = [];
afterAll(() => { for (const h of homes) rmSync(h, { recursive: true, force: true }); });
const tempHome = () => { const h = mkdtempSync(join(tmpdir(), 'buildd-client-')); homes.push(h); return h; };

const between = (begin: string, end: string) => installSh.slice(installSh.indexOf(begin), installSh.indexOf(end) + end.length);
const CLIENT_FNS = between('# --- client mode: begin ---', '# --- client mode: end ---');
const NEXT_FNS = between('# --- next steps: begin ---', '# --- next steps: end ---');

function bash(script: string, home: string, extraEnv: Record<string, string> = {}) {
  const r = Bun.spawnSync(['bash', '-c', `GREEN=''; YELLOW=''; RED=''; NC=''\n${script}`], {
    env: { HOME: home, PATH: process.env.PATH ?? '/usr/bin:/bin', ...extraEnv },
  });
  return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
}

describe('install.sh --client guard', () => {
  test('a fresh machine or an existing client install proceeds', () => {
    const fresh = tempHome();
    expect(bash(`${CLIENT_FNS}\nclient_mode_guard "$HOME/.buildd"; echo "rc=$?"`, fresh).out).toContain('rc=0');
    const client = tempHome();
    mkdirSync(join(client, '.buildd', '.git'), { recursive: true });
    writeFileSync(join(client, '.buildd', '.client-only'), '');
    expect(bash(`${CLIENT_FNS}\nclient_mode_guard "$HOME/.buildd"; echo "rc=$?"`, client).out).toContain('rc=0');
  });

  test('a full runner install is never turned into a client one', () => {
    const full = tempHome();
    mkdirSync(join(full, '.buildd', '.git'), { recursive: true });
    mkdirSync(join(full, '.buildd', 'apps', 'runner', 'src'), { recursive: true });
    writeFileSync(join(full, '.buildd', 'apps', 'runner', 'src', 'index.ts'), '');
    const r = bash(`${CLIENT_FNS}\nclient_mode_guard "$HOME/.buildd"; echo "rc=$?"`, full);
    expect(r.out).toContain('rc=1');
    expect(r.out).toContain('already has the full buildd runner');
    expect(r.out).toContain('buildd login');
    expect(existsSync(join(full, '.buildd', 'apps', 'runner', 'src', 'index.ts'))).toBe(true);
  });
});

describe('install.sh --client next steps', () => {
  test('logged in: reload, then buildd install --global, and nothing about the runner', () => {
    const h = tempHome();
    mkdirSync(join(h, '.buildd'));
    writeFileSync(join(h, '.buildd', 'config.json'), JSON.stringify({ apiKey: 'bld_test_key' }));
    const { code, out } = bash(`${NEXT_FNS}\n${CLIENT_FNS}\nprint_client_next_steps "$(buildd_login_source)"`, h);
    expect(code).toBe(0);
    expect(out).toContain('buildd install --global');
    expect(out).not.toContain('buildd login ');
    expect(out).not.toMatch(/service install|start the runner/);
  });

  test('not logged in: buildd login first, then buildd install --global', () => {
    const { out } = bash(`${NEXT_FNS}\n${CLIENT_FNS}\nprint_client_next_steps ""`, tempHome());
    expect(out.indexOf('buildd login')).toBeGreaterThan(-1);
    expect(out.indexOf('buildd login')).toBeLessThan(out.indexOf('buildd install --global'));
  });
});

describe('launcher in client mode', () => {
  const launcher = installSh.match(/cat > "\$BIN_DIR\/buildd" << 'LAUNCHER'\n([\s\S]*?)\nLAUNCHER/)?.[1] ?? '';

  function runLauncher(args: string[], clientOnly: boolean) {
    const h = tempHome();
    mkdirSync(join(h, '.buildd'), { recursive: true });
    if (clientOnly) writeFileSync(join(h, '.buildd', '.client-only'), '');
    const file = join(h, 'buildd');
    writeFileSync(file, launcher);
    // No bun on PATH: a client-mode refusal must not need it.
    const r = Bun.spawnSync(['bash', file, ...args], { env: { HOME: h, PATH: '/usr/bin:/bin' } });
    return { code: r.exitCode, out: new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr) };
  }

  test('starting the runner says it is not installed and how to add it, instead of crashing', () => {
    for (const args of [[], ['--debug'], ['service', 'install'], ['service', 'status']]) {
      const r = runLauncher(args, true);
      expect(r.code).toBe(3);
      expect(r.out).toContain("isn't installed");
      expect(r.out).toContain('curl -fsSL https://buildd.dev/install.sh | bash');
    }
  });

  test('help lists what client mode has, without loading the runner', () => {
    const r = runLauncher(['--help'], true);
    expect(r.code).toBe(0);
    expect(r.out).toContain('Usage: buildd');
    expect(r.out).toContain('buildd login');
    expect(r.out).toContain('buildd install --global');
  });
});

describe('buildd login --help', () => {
  test('prints usage and exits 0 without logging in', () => {
    const h = tempHome();
    const r = Bun.spawnSync(['bun', '--no-env-file', join(repoRoot, 'apps/runner/src/login.ts'), '--help'], {
      env: { HOME: h, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    const out = new TextDecoder().decode(r.stdout);
    expect(r.exitCode).toBe(0);
    expect(out).toContain('Usage: buildd login');
    expect(out).toContain('--device');
    expect(existsSync(join(h, '.buildd', 'config.json'))).toBe(false);
  });
});
