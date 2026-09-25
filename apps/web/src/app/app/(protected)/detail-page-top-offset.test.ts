/**
 * `pt-14` reserves room for the fixed MobilePageHeader. That header renders
 * nothing on a detail route (`mobilePageTitle` → null), so a detail page that
 * kept `pt-14` opened on a ~56px blank band on a phone (mobile QA).
 * This pins the pairing: no title ⇒ no reserved offset.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mobilePageTitle } from '@/lib/nav-config';

const DETAIL_PAGES: Array<{ route: string; file: string }> = [
  { route: '/app/artifacts/some-id', file: 'artifacts/[id]/page.tsx' },
  { route: '/app/initiatives/some-id', file: 'initiatives/[id]/page.tsx' },
  { route: '/app/releases/some-id', file: 'releases/[id]/page.tsx' },
];

describe('detail pages without a mobile header reserve no header offset', () => {
  for (const { route, file } of DETAIL_PAGES) {
    it(file, () => {
      const src = readFileSync(join(import.meta.dir, file), 'utf8');
      if (mobilePageTitle(route) === null) {
        expect(src).not.toMatch(/(^|[\s"'`])pt-14(?=[\s"'`])/);
      } else {
        expect(src).toMatch(/(^|[\s"'`])pt-14(?=[\s"'`])/);
      }
    });
  }
});
