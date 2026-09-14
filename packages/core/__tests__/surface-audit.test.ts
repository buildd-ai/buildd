import { describe, it, expect } from 'bun:test';
import {
  SURFACE_AUDIT_TITLE_PREFIX,
  buildSurfaceAuditDescription,
  isSurfaceAuditTask,
  isUiSurfacePath,
  surfaceAuditTitle,
  touchesUiSurface,
} from '../surface-audit';

describe('isUiSurfacePath', () => {
  it('matches paths under apps/web/src/app/', () => {
    expect(isUiSurfacePath('apps/web/src/app/(protected)/team/page.tsx')).toBe(true);
  });

  it('matches paths under apps/web/src/components/', () => {
    expect(isUiSurfacePath('apps/web/src/components/TeamGrid.tsx')).toBe(true);
  });

  it('does not match sibling directories with a similar prefix', () => {
    expect(isUiSurfacePath('apps/web/src/appendix/foo.ts')).toBe(false);
    expect(isUiSurfacePath('apps/web/src/components-legacy/foo.ts')).toBe(false);
  });

  it('does not match backend or non-web paths', () => {
    expect(isUiSurfacePath('apps/web/src/lib/foo.ts')).toBe(false);
    expect(isUiSurfacePath('packages/core/db/schema.ts')).toBe(false);
    expect(isUiSurfacePath('apps/runner/src/workers.ts')).toBe(false);
  });
});

describe('touchesUiSurface', () => {
  it('is true when at least one concrete path is a UI surface path', () => {
    expect(touchesUiSurface(['packages/core/mission-helpers.ts', 'apps/web/src/components/Foo.tsx'])).toBe(true);
  });

  it('is false when no path is under a UI surface directory', () => {
    expect(touchesUiSurface(['packages/core/mission-helpers.ts', 'apps/web/src/lib/foo.ts'])).toBe(false);
  });

  it('is false for null, undefined, or empty manifests', () => {
    expect(touchesUiSurface(null)).toBe(false);
    expect(touchesUiSurface(undefined)).toBe(false);
    expect(touchesUiSurface([])).toBe(false);
  });

  it('is false for the repo-wide sentinel — advisory-only, not a UI declaration', () => {
    expect(touchesUiSurface(['**'])).toBe(false);
  });

  it('is false when the sentinel rides along with a UI path — sentinel means undeclared scope', () => {
    expect(touchesUiSurface(['**', 'apps/web/src/app/page.tsx'])).toBe(false);
  });
});

describe('isSurfaceAuditTask / surfaceAuditTitle', () => {
  it('round-trips: a title minted by surfaceAuditTitle is recognized by isSurfaceAuditTask', () => {
    const title = surfaceAuditTitle('Mobile nav redesign');
    expect(title.startsWith(SURFACE_AUDIT_TITLE_PREFIX)).toBe(true);
    expect(isSurfaceAuditTask(title)).toBe(true);
  });

  it('does not flag an unrelated title', () => {
    expect(isSurfaceAuditTask('Build the mobile nav')).toBe(false);
  });
});

describe('buildSurfaceAuditDescription', () => {
  it('lists scoped paths and the reused checklist items', () => {
    const desc = buildSurfaceAuditDescription({
      missionTitle: 'Mobile nav redesign',
      scopedPaths: ['apps/web/src/components/MobileNav.tsx'],
    });
    expect(desc).toContain('Mobile nav redesign');
    expect(desc).toContain('apps/web/src/components/MobileNav.tsx');
    expect(desc).toContain('390pt and 320pt viewport walk');
    expect(desc).toContain('CTA set derived from LIVE server state');
    expect(desc).toContain('Empty, error, and loading rendering');
    expect(desc).toContain('duplicate chrome titles');
    expect(desc).toContain('THIS SAME mission');
  });

  it('falls back to a description-scan note when no concrete paths were declared', () => {
    const desc = buildSurfaceAuditDescription({ missionTitle: 'Mobile nav redesign', scopedPaths: [] });
    expect(desc).toContain('no concrete paths declared');
  });
});
