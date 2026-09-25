/**
 * `pt-14` reserves room for the fixed MobilePageHeader. That header renders
 * nothing where `mobilePageTitle` is null (detail and form routes), so a page
 * that kept `pt-14` there opened on a ~56px blank band on a phone (mobile QA).
 * This pins the pairing for every page under (protected): no title ⇒ no
 * reserved offset.
 */
import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { mobilePageTitle } from '@/lib/nav-config';

const ROOT = import.meta.dir;
const PT14 = /(^|[\s"'`])pt-14(?=[\s"'`]|$)/m;

/**
 * Pages owned by another in-flight change; each must be removed from this
 * list when its owner drops the offset (the test fails if an entry goes stale).
 */
const KNOWN_EXCEPTIONS = new Set<string>([
  'accounts/new/page.tsx', // accounts/** — config PR
]);

function pages(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return pages(full);
    return name === 'page.tsx' ? [full] : [];
  });
}

/** `missions/[id]/page.tsx` → `/app/missions/x`; route groups `(g)` drop out. */
function routeOf(file: string): string {
  const segs = relative(ROOT, file).split(sep).slice(0, -1)
    .filter(s => !/^\(.*\)$/.test(s))
    .map(s => (/^\[.*\]$/.test(s) ? 'x' : s));
  return ['/app', ...segs].join('/');
}

const ALL = pages(ROOT).map(file => ({ file, rel: relative(ROOT, file).split(sep).join('/'), route: routeOf(file) }));

describe('pages without a mobile header reserve no header offset', () => {
  it('finds the page tree', () => {
    expect(ALL.length).toBeGreaterThan(20);
    expect(ALL.some(p => p.route === '/app/missions')).toBe(true);
  });

  for (const { file, rel, route } of ALL) {
    if (mobilePageTitle(route) !== null) continue;
    it(`${rel} (${route})`, () => {
      const hasOffset = PT14.test(readFileSync(file, 'utf8'));
      if (KNOWN_EXCEPTIONS.has(rel)) {
        // Stale exception: the owner fixed it, so drop it from the list.
        expect(hasOffset).toBe(true);
      } else {
        expect(hasOffset).toBe(false);
      }
    });
  }
});
