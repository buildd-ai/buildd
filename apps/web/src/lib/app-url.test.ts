/**
 * Unit test: appBaseUrl precedence (C19).
 *
 * The bug it replaces produced "https://undefined" whenever NEXT_PUBLIC_APP_URL
 * was set and VERCEL_URL was not — i.e. on production and on every local run —
 * because `A || B ? …` binds as `(A || B) ? …`.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/web/src/lib/app-url.test.ts
 */

import { describe, it, expect, afterEach } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { appBaseUrl } from './app-url';

const APP = process.env.NEXT_PUBLIC_APP_URL;
const VERCEL = process.env.VERCEL_URL;
const VERCEL_ENV = process.env.VERCEL_ENV;
const PROD_HOST = process.env.VERCEL_PROJECT_PRODUCTION_URL;

function put(name: string, value?: string) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function setEnv(app?: string, vercel?: string, vercelEnv?: string, prodHost?: string) {
  put('NEXT_PUBLIC_APP_URL', app);
  put('VERCEL_URL', vercel);
  put('VERCEL_ENV', vercelEnv);
  put('VERCEL_PROJECT_PRODUCTION_URL', prodHost);
}

afterEach(() => setEnv(APP, VERCEL, VERCEL_ENV, PROD_HOST));

describe('appBaseUrl', () => {
  it('prefers NEXT_PUBLIC_APP_URL over the Vercel host', () => {
    setEnv('https://buildd.dev', 'preview-xyz.vercel.app');
    expect(appBaseUrl()).toBe('https://buildd.dev');
  });

  it('does NOT return https://undefined when only NEXT_PUBLIC_APP_URL is set', () => {
    setEnv('https://buildd.dev', undefined);
    expect(appBaseUrl()).toBe('https://buildd.dev');
    expect(appBaseUrl()).not.toContain('undefined');
  });

  it('falls back to the Vercel deployment host', () => {
    setEnv(undefined, 'preview-xyz.vercel.app');
    expect(appBaseUrl()).toBe('https://preview-xyz.vercel.app');
  });

  // A production deployment's VERCEL_URL is its own per-deployment host,
  // behind Vercel's login wall. A link minted there (a spec approval
  // confirmation, an incident deep link) has to name the public domain.
  it('uses the production domain, not the deployment host, on a production deployment', () => {
    setEnv(undefined, 'buildd-abc123-team.vercel.app', 'production', 'buildd.dev');
    expect(appBaseUrl()).toBe('https://buildd.dev');
  });

  it('keeps the deployment host on a preview deployment', () => {
    setEnv(undefined, 'buildd-git-x-team.vercel.app', 'preview', 'buildd.dev');
    expect(appBaseUrl()).toBe('https://buildd-git-x-team.vercel.app');
  });

  it('never names a deployment host on production, even without the production domain variable', () => {
    setEnv(undefined, 'buildd-abc123-team.vercel.app', 'production', undefined);
    expect(appBaseUrl()).toBe('https://buildd.dev');
  });

  it('falls back to production when nothing is configured', () => {
    setEnv(undefined, undefined);
    expect(appBaseUrl()).toBe('https://buildd.dev');
  });

  it('drops a trailing slash so `${base}/share/x` never doubles up', () => {
    setEnv('https://buildd.dev/', undefined);
    expect(appBaseUrl()).toBe('https://buildd.dev');
  });
});

describe('no call site open-codes the precedence again', () => {
  it('has zero occurrences of the broken ternary in apps/web/src', () => {
    // Measured, not asserted-by-vibe: print the count so a regression that
    // reintroduces one site is visible, not just "false".
    const files = execSync(
      "git grep -l 'NEXT_PUBLIC_APP_URL' -- 'apps/web/src' || true",
      { encoding: 'utf8' },
    )
      .split('\n')
      .filter(Boolean)
      .filter(f => !f.endsWith('app-url.test.ts'));

    const broken: string[] = [];
    for (const f of files) {
      const src = readFileSync(f, 'utf8');
      // `NEXT_PUBLIC_APP_URL || process.env.VERCEL_URL` followed by a `?`.
      if (/NEXT_PUBLIC_APP_URL\s*\|\|\s*process\.env\.VERCEL_URL\s*\n?\s*\?/.test(src)) {
        broken.push(f);
      }
    }
    expect({ scanned: files.length, broken }).toEqual({ scanned: files.length, broken: [] });
    expect(files.length).toBeGreaterThan(5);
  });
});
