import { describe, it, expect } from 'bun:test';
import { visualQaRequiredRoutes } from './visual-qa-required-routes';
import manifest from '@/qa/visual-qa-routes.json';

describe('visualQaRequiredRoutes', () => {
  it('maps a changed page file to its route', () => {
    expect(visualQaRequiredRoutes(['apps/web/src/app/app/(protected)/missions/[id]/page.tsx'])).toEqual([
      '/app/missions/:id',
    ]);
  });

  it('fans a changed group layout out to every real manifest route under /app', () => {
    const routes = visualQaRequiredRoutes(['apps/web/src/app/app/(protected)/layout.tsx']);
    const underApp = manifest.routes.map((r) => r.path).filter((p) => p.startsWith('/app/'));
    expect(underApp.length).toBeGreaterThan(0);
    for (const p of underApp) expect(routes).toContain(p);
  });

  it('gives nothing for non-route files', () => {
    expect(visualQaRequiredRoutes(['apps/web/src/components/Foo.tsx', 'packages/core/x.ts'])).toEqual([]);
  });
});
