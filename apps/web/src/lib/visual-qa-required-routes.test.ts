import { describe, it, expect } from 'bun:test';
import { visualQaRequiredRoutes, auditRequiredRoutes } from './visual-qa-required-routes';
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

// One derivation for the completion gate (loadVisualAuditEvidence) and the
// mission page's n/m coverage.
describe('auditRequiredRoutes', () => {
  const page = 'apps/web/src/app/app/(protected)/missions/[id]/page.tsx';
  it("unions the dependencies' changed-file routes with the frozen context.visualQa.requiredRoutes, sorted", () => {
    expect(auditRequiredRoutes(
      { context: { visualQa: { requiredRoutes: ['/app/tasks', 'no-slash', 3] } } },
      [{ pathManifest: [page] }, null, { pathManifest: ['**'] }, { pathManifest: 'x' }],
    )).toEqual(['/app/missions/:id', '/app/tasks']);
  });
  // A refresh that merged dev into its branch has dev's whole diff as its claim
  // manifest, shared layouts included: one such edge demanded every /app route.
  it('ignores a dependency that merged trunk in, whose manifest is trunk\'s diff', () => {
    const widened = [page, 'apps/web/src/app/app/(protected)/layout.tsx', 'packages/core/x.ts'];
    const builder = { title: 'fix(missions): true states', context: null, pathManifest: [page] };
    for (const refresh of [
      { title: 'chore(mission): merge dev into the Restore trust integration branch', context: null, pathManifest: widened },
      { title: 'Refresh the mission branch', context: { requireMergeCommit: true, refreshTrunk: 'dev' }, pathManifest: widened },
    ]) {
      expect(auditRequiredRoutes({ context: null }, [builder, refresh])).toEqual(['/app/missions/:id']);
    }
    // The same paths on builder work still fan out.
    expect(auditRequiredRoutes({ context: null }, [{ ...builder, pathManifest: widened }]).length).toBeGreaterThan(1);
  });
  it('is empty with no dependencies and no frozen list', () => {
    expect(auditRequiredRoutes({ context: null }, [])).toEqual([]);
    expect(auditRequiredRoutes({}, [])).toEqual([]);
  });
});
