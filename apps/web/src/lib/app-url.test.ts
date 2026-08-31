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

function setEnv(app?: string, vercel?: string) {
  if (app === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = app;
  if (vercel === undefined) delete process.env.VERCEL_URL;
  else process.env.VERCEL_URL = vercel;
}

afterEach(() => setEnv(APP, VERCEL));

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
