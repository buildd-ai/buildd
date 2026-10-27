import { describe, expect, test } from 'bun:test';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { HEALTH_NAV, NAV_ITEMS } from '@/lib/nav-config';
import manifest from './visual-qa-routes.json';

const APP_DIR = join(import.meta.dir, '..', 'app');

/** Manifest path with its query string and trailing slash removed. */
const pathOf = (p: string) => p.replace(/[?#].*$/, '').replace(/\/+$/, '') || '/';

/**
 * Does a page.tsx exist for this path? A `:param` segment matches any dynamic
 * `[param]` directory; `(group)` directories are transparent.
 */
function hasPage(dir: string, segments: string[]): boolean {
  if (segments.length === 0) return existsSync(join(dir, 'page.tsx'));
  if (!existsSync(dir)) return false;
  const [head, ...rest] = segments;
  const entries = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  return entries.some((e) => {
    const name = e.name;
    const isGroup = /^\(.+\)$/.test(name);
    const isDynamic = /^\[[^\]]+\]$/.test(name);
    if (isGroup) return hasPage(join(dir, name), segments);
    if (name === head) return hasPage(join(dir, name), rest);
    return isDynamic && head.startsWith(':') && hasPage(join(dir, name), rest);
  });
}

/** Failure messages for the nav destinations a manifest does not cover, and the manifest paths no page serves. */
export function manifestProblems(
  paths: readonly string[],
  required: ReadonlyArray<{ label: string; href: string }>,
  pageExists: (path: string) => boolean = (p) => hasPage(APP_DIR, p.split('/').filter(Boolean)),
): string[] {
  const covered = new Set(paths.map(pathOf));
  const problems: string[] = [];
  for (const r of required) {
    if (!covered.has(r.href)) {
      problems.push(`Nav destination "${r.label}" (${r.href}) has no entry in apps/web/src/qa/visual-qa-routes.json: add a manifest entry for it.`);
    }
  }
  for (const p of paths) {
    if (!pageExists(pathOf(p))) {
      problems.push(`Manifest route ${p} resolves to no page under apps/web/src/app (removed or redirected?): remove its entry from apps/web/src/qa/visual-qa-routes.json or point it at the real page.`);
    }
  }
  return problems;
}

const manifestPaths = manifest.routes.map((r) => r.path);
const requiredNav = [
  ...NAV_ITEMS,
  ...HEALTH_NAV.filter((h) => h.core),
];

describe('visual QA route manifest', () => {
  test('covers every primary and core Health destination, and every route has a page', () => {
    expect(manifestProblems(manifestPaths, requiredNav)).toEqual([]);
  });

  test('every route has expectations and a unique id', () => {
    const ids = manifest.routes.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of manifest.routes) {
      expect(r.expectations.length).toBeGreaterThanOrEqual(3);
      expect(r.expectations.length).toBeLessThanOrEqual(5);
    }
  });

  test('a nav item added without an entry fails, naming the route', () => {
    const problems = manifestProblems(manifestPaths, [...requiredNav, { label: 'Reports', href: '/app/reports' }]);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/app/reports');
    expect(problems[0]).toContain('add a manifest entry');
  });

  test('a manifest route with no page fails, naming the route', () => {
    const problems = manifestProblems([...manifestPaths, '/app/team'], requiredNav);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('/app/team');
    expect(problems[0]).toContain('remove its entry');
  });
});
