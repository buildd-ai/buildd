/**
 * Pages must not skip their data queries just because NODE_ENV is development.
 *
 * The `isDev` gates date from the first dashboard scaffold, when local dev had
 * no database. Keyed on NODE_ENV alone they kept `bun dev` blank even with a
 * real DATABASE_URL and DEV_USER_EMAIL (which getCurrentUser already honours),
 * so local QA could not see these pages. They now fire only when there is no
 * DATABASE_URL — the no-DB escape hatch the gates were written for.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

const ROOT = import.meta.dir;

function pageFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return pageFiles(p);
    return name === 'page.tsx' ? [p] : [];
  });
}

const GATE = /const\s+isDev\s*=\s*process\.env\.NODE_ENV\s*===\s*'development'([^;]*);/;

const API_ROOT = join(ROOT, '../../api');

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === 'route.ts' ? [p] : [];
  });
}

/**
 * Routes still short-circuiting on NODE_ENV alone, on purpose. These
 * authenticate with next-auth `auth()` directly rather than getCurrentUser, and
 * local dev has no session under DEV_USER_EMAIL — un-gating them would turn an
 * empty dev response into a 401, not into real data. Moving them to
 * getCurrentUser is the fix; until then they stay gated. Shrink this list only.
 */
const AUTH_SESSION_ONLY = new Set([
  'workspaces/[id]/accounts/route.ts',
  'github/installations/route.ts',
  'github/installations/[id]/route.ts',
  'github/installations/[id]/repos/route.ts',
]);

const DEV_GATE_LINE = /process\.env\.NODE_ENV\s*===\s*'development'/;

describe('dev data gates: API', () => {
  const gated = routeFiles(API_ROOT).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^\s*if\s*\(/.test(l) && DEV_GATE_LINE.test(l))
      .map((line) => ({ file: file.slice(API_ROOT.length + 1), line })),
  );

  it('finds the gated routes (guards against this test matching nothing)', () => {
    expect(gated.length).toBeGreaterThan(0);
  });

  it.each(['workspaces/route.ts', 'tasks/route.ts', 'accounts/route.ts'])('%s is scanned', (f) => {
    expect(gated.map((g) => g.file)).toContain(f);
  });

  it('every dev short-circuit in app/api also requires DATABASE_URL to be absent (except the auth()-only routes)', () => {
    const nodeEnvOnly = gated
      .filter((g) => !AUTH_SESSION_ONLY.has(g.file) && !g.line.includes('!process.env.DATABASE_URL'))
      .map((g) => `${g.file}: ${g.line.trim()}`);
    expect(nodeEnvOnly).toEqual([]);
  });

  it('the auth()-only exemptions are still real (drop an entry once its route moves to getCurrentUser)', () => {
    for (const f of AUTH_SESSION_ONLY) {
      const src = readFileSync(join(API_ROOT, f), 'utf8');
      expect(src).toContain('await auth()');
      expect(src).not.toContain('getCurrentUser');
    }
  });
});

describe('dev data gates', () => {
  const gated = pageFiles(ROOT)
    .map((file) => ({ file: file.slice(ROOT.length + 1), m: readFileSync(file, 'utf8').match(GATE) }))
    .filter((g) => g.m);

  it('finds the gated pages (guards against this test matching nothing)', () => {
    expect(gated.length).toBeGreaterThan(0);
  });

  it.each(['home/page.tsx', 'tasks/page.tsx', 'workspaces/page.tsx'])('%s is among them', (f) => {
    expect(gated.map((g) => g.file)).toContain(f);
  });

  it('every isDev gate also requires DATABASE_URL to be absent', () => {
    const nodeEnvOnly = gated.filter((g) => !/!\s*process\.env\.DATABASE_URL/.test(g.m![1])).map((g) => g.file);
    expect(nodeEnvOnly).toEqual([]);
  });
});
