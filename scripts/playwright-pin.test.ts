import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'fs';
import { execFileSync } from 'child_process';
import { join } from 'path';

/**
 * One Playwright version for the whole repo, and every runner-side install
 * going through it.
 *
 * Each Playwright version needs exactly one Chromium build, and
 * `playwright install` run from a different version garbage-collects the
 * others from the shared browsers directory — including the build the
 * runner's browser self-check launches. A runner went `browser: no` that way:
 * the repo, a bare `bunx playwright` and the runner image each installed a
 * different version into the same cache.
 *
 * The pin is the exact `playwright` version in apps/runner/package.json. The
 * infrastructure repo's runner image reads it from there at build time
 * (`jq -r .devDependencies.playwright apps/runner/package.json`), so it must
 * stay an exact version, not a range.
 */

const repoRoot = join(__dirname, '..');
const PLAYWRIGHT_PACKAGES = ['playwright', 'playwright-core', '@playwright/test'];
const EXACT = /^\d+\.\d+\.\d+$/;

function tracked(...pathspecs: string[]): string[] {
  return execFileSync('git', ['ls-files', '-z', '--', ...pathspecs], { cwd: repoRoot, encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
}

function readJson(rel: string): any {
  return JSON.parse(readFileSync(join(repoRoot, rel), 'utf8'));
}

const pin: string = readJson('apps/runner/package.json').devDependencies?.playwright;

describe('Playwright pin', () => {
  it('apps/runner/package.json pins an exact playwright version', () => {
    expect(pin).toMatch(EXACT);
  });

  it('every package.json declaring a Playwright package uses the same exact version', () => {
    const drift: string[] = [];
    for (const file of tracked('package.json', '*/package.json', '**/package.json')) {
      const pkg = readJson(file);
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of PLAYWRIGHT_PACKAGES) {
          const spec = pkg[field]?.[name];
          if (spec !== undefined && spec !== pin) drift.push(`${file} ${field}.${name} = ${spec}`);
        }
      }
    }
    expect(drift).toEqual([]);
  });

  it('bun.lock resolves every Playwright package to the pin and nothing else', () => {
    const lock = readFileSync(join(repoRoot, 'bun.lock'), 'utf8');
    const resolved = new Set<string>();
    for (const name of PLAYWRIGHT_PACKAGES) {
      const re = new RegExp(`"${name.replace('/', '\\/')}@(\\d+\\.\\d+\\.\\d+[^"]*)"`, 'g');
      for (const m of lock.matchAll(re)) resolved.add(`${name}@${m[1]}`);
    }
    expect([...resolved].filter(r => !r.endsWith(`@${pin}`))).toEqual([]);
    expect(resolved.has(`playwright@${pin}`)).toBe(true);
  });

  it('Renovate bumps all Playwright packages together, as an exact pin', () => {
    const rules: any[] = readJson('renovate.json').packageRules ?? [];
    const rule = rules.find(r => PLAYWRIGHT_PACKAGES.every(p => r.matchPackageNames?.includes(p)));
    expect(rule?.groupName).toBeTruthy();
    expect(rule?.rangeStrategy).toBe('pin');
  });

  it('runner-side installers never use a bare bunx/npx playwright install', () => {
    // Throwaway kits (the visual-review skill) may, because they set their own
    // PLAYWRIGHT_BROWSERS_PATH; nothing that runs on a runner or in CI may.
    const files = tracked('apps/runner', '.github/workflows', 'scripts')
      .filter(f => /\.(sh|ts|ya?ml|json)$/.test(f) && f !== 'scripts/playwright-pin.test.ts');
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(join(repoRoot, file), 'utf8').split('\n').forEach((line, i) => {
        if (/\b(bunx|npx)\s+playwright\s+install(?!-deps)/.test(line)) hits.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('apps/runner exposes browser:install through its own pinned binary', () => {
    expect(readJson('apps/runner/package.json').scripts?.['browser:install']).toBe('playwright install chromium');
  });
});
