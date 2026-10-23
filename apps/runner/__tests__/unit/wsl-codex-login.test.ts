/**
 * `buildd codex login` never needs Node (spec a0b82b5d R-11, AC-8).
 *
 * On a fresh Ubuntu (WSL included) a separately installed `codex` command is
 * the npm package's bin/codex.js and dies with "env: 'node': No such file or
 * directory". This command runs the native binary the runner's Codex SDK
 * already installed, so Bun is all the machine needs.
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { delimiter, dirname, join } from 'path';
import { locateBundledCodex, planCodexCommand, type CodexLocateDeps } from '../../src/codex-login';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** A node_modules tree laid out as bun installs @openai/codex and its platform package. */
function fakeTree(platform: string, arch: string, triple: string, platformPkg: string, layout: 'current' | 'legacy' | 'none') {
  const root = mkdtempSync(join(tmpdir(), 'buildd-codex-tree-'));
  dirs.push(root);
  const codex = join(root, 'node_modules/@openai/codex');
  mkdirSync(join(codex, 'bin'), { recursive: true });
  writeFileSync(join(codex, 'package.json'), '{}');
  // The Node shim a global `npm i -g @openai/codex` puts on PATH: never chosen.
  writeFileSync(join(codex, 'bin/codex.js'), '#!/usr/bin/env node\n');
  const plat = join(root, 'node_modules', platformPkg);
  mkdirSync(plat, { recursive: true });
  writeFileSync(join(plat, 'package.json'), '{}');
  const exe = platform === 'win32' ? 'codex.exe' : 'codex';
  const vendor = join(plat, 'vendor', triple);
  if (layout === 'current') {
    mkdirSync(join(vendor, 'bin'), { recursive: true });
    mkdirSync(join(vendor, 'codex-path'), { recursive: true });
    writeFileSync(join(vendor, 'bin', exe), '');
    writeFileSync(join(vendor, 'codex-package.json'), '{}');
  } else if (layout === 'legacy') {
    mkdirSync(join(vendor, 'codex'), { recursive: true });
    writeFileSync(join(vendor, 'codex', exe), '');
  }
  const sdkEntry = join(root, 'node_modules/@openai/codex-sdk/dist/index.js');
  const deps: CodexLocateDeps = {
    platform, arch,
    sdkEntry: () => sdkEntry,
    resolve: (spec) => {
      const p = join(root, 'node_modules', spec);
      if (!existsSync(p)) throw new Error(`Cannot find ${spec}`);
      return p;
    },
    isFile: (p) => { try { return statSync(p).isFile(); } catch { return false; } },
    isDir: (p) => { try { return statSync(p).isDirectory(); } catch { return false; } },
  };
  return { deps, vendor, codex, exe };
}

describe('the Codex binary buildd codex login runs', () => {
  test('linux x64 (WSL): the native musl binary, not bin/codex.js', () => {
    const t = fakeTree('linux', 'x64', 'x86_64-unknown-linux-musl', '@openai/codex-linux-x64', 'current');
    const found = locateBundledCodex(t.deps)!;
    expect(found.executablePath).toBe(join(t.vendor, 'bin', 'codex'));
    expect(found.executablePath.endsWith('.js')).toBe(false);
    expect(found.pathDirs).toEqual([join(t.vendor, 'codex-path')]);
  });

  test('linux arm64, macOS and Windows resolve their own platform package', () => {
    expect(locateBundledCodex(fakeTree('linux', 'arm64', 'aarch64-unknown-linux-musl', '@openai/codex-linux-arm64', 'current').deps)).not.toBeNull();
    expect(locateBundledCodex(fakeTree('darwin', 'arm64', 'aarch64-apple-darwin', '@openai/codex-darwin-arm64', 'current').deps)).not.toBeNull();
    const win = fakeTree('win32', 'x64', 'x86_64-pc-windows-msvc', '@openai/codex-win32-x64', 'current');
    expect(locateBundledCodex(win.deps)!.executablePath).toBe(join(win.vendor, 'bin', 'codex.exe'));
  });

  test('the older vendor layout is still found', () => {
    const t = fakeTree('linux', 'x64', 'x86_64-unknown-linux-musl', '@openai/codex-linux-x64', 'legacy');
    expect(locateBundledCodex(t.deps)!.executablePath).toBe(join(t.vendor, 'codex', 'codex'));
  });

  test('no native binary: null, never the Node shim', () => {
    const t = fakeTree('linux', 'x64', 'x86_64-unknown-linux-musl', '@openai/codex-linux-x64', 'none');
    expect(locateBundledCodex(t.deps)).toBeNull();
  });
});

describe('planCodexCommand', () => {
  const bundled = { executablePath: '/r/vendor/x/bin/codex', pathDirs: ['/r/vendor/x/codex-path'] };

  test('login runs the bundled binary directly, args passed through, its PATH dirs first', () => {
    const plan = planCodexCommand(['login', '--device-auth'], bundled, { PATH: ['/usr/bin', '/bin'].join(delimiter), HOME: '/h' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.file).toBe(bundled.executablePath);
    expect(plan.args).toEqual(['login', '--device-auth']);
    expect(plan.env.PATH).toBe(['/r/vendor/x/codex-path', '/usr/bin', '/bin'].join(delimiter));
    expect(plan.env.HOME).toBe('/h');
  });

  test('logout passes through; anything else is refused with usage', () => {
    expect(planCodexCommand(['logout'], bundled, {}).ok).toBe(true);
    const exec = planCodexCommand(['exec', 'rm -rf /'], bundled, {});
    expect(exec).toMatchObject({ ok: false, code: 64 });
    expect(planCodexCommand([], bundled, {})).toMatchObject({ ok: false, code: 64 });
  });

  test('no bundled binary: says to reinstall the runner, and does not fall back to a codex on PATH', () => {
    const plan = planCodexCommand(['login'], null, { PATH: '/usr/local/bin' });
    expect(plan).toMatchObject({ ok: false, code: 1 });
    if (!plan.ok) expect(plan.message).toContain('install.sh');
  });
});

// The real thing: the runner's own installed Codex, started with a PATH that
// holds Bun and nothing else, so a Node anywhere on this machine cannot help.
describe.skipIf(process.platform === 'win32')('buildd codex login with no Node on PATH', () => {
  test('starts the bundled Codex login', () => {
    const found = locateBundledCodex();
    expect(found).not.toBeNull();
    const bunDir = dirname(process.execPath);
    const r = Bun.spawnSync([process.execPath, '--no-env-file', 'run', join(import.meta.dir, '../../src/codex-login.ts'), 'login', '--help'], {
      env: { PATH: bunDir, HOME: mkdtempSync(join(tmpdir(), 'buildd-codex-home-')) },
    });
    const out = new TextDecoder().decode(r.stdout) + new TextDecoder().decode(r.stderr);
    expect(out).not.toContain("'node'");
    expect(r.exitCode).toBe(0);
    expect(out.toLowerCase()).toContain('login');
  });
});
