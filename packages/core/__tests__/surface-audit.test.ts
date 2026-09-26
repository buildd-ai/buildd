import { describe, it, expect } from 'bun:test';
import {
  MAX_SURFACE_AUDIT_ROUNDS,
  SURFACE_AUDIT_TITLE_PREFIX,
  SURFACE_FIX_TITLE_PREFIX,
  buildSurfaceAuditDescription,
  isSurfaceAuditTask,
  isSurfaceFixTask,
  isUiSurfacePath,
  planSurfaceFixFollowUp,
  surfaceAuditRound,
  surfaceAuditTitle,
  surfaceFixRoute,
  surfaceFixTitle,
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

  it('does not match Next.js API route handlers, despite the shared apps/web/src/app/ prefix', () => {
    expect(isUiSurfacePath("apps/web/src/app/api/workers/[id]/route.ts")).toBe(false);
    expect(isUiSurfacePath("apps/web/src/app/api/workers/[id]/route.test.ts")).toBe(false);
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

  it('is false for a mission scoped entirely to API route paths plus non-UI file types', () => {
    expect(touchesUiSurface([
      'apps/web/src/app/api/workers/[id]/route.ts',
      'apps/web/src/app/api/workers/[id]/route.test.ts',
      'docs/specs/mission-task-lifecycle.md',
    ])).toBe(false);
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

  it('lists the required routes and the per-shot evidence contract', () => {
    const desc = buildSurfaceAuditDescription({
      missionTitle: 'Mobile nav redesign',
      scopedPaths: ['apps/web/src/app/app/(protected)/missions/page.tsx'],
      requiredRoutes: ['/app/missions', '/app/tasks/:id'],
    });
    expect(desc).toContain('- `/app/missions`');
    expect(desc).toContain('- `/app/tasks/:id`');
    expect(desc).toContain('mobile');
    expect(desc).toContain('desktop');
    expect(desc).toContain('visual-review');
    expect(desc).toContain('upload_artifact');
    expect(desc).toContain('[surface fix]');
  });

  it('says so when no required route could be derived (auditor picks, but still shoots)', () => {
    const desc = buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [], requiredRoutes: [] });
    expect(desc).toContain('no required routes derived');
  });

  it('falls back to a description-scan note when no concrete paths were declared', () => {
    const desc = buildSurfaceAuditDescription({ missionTitle: 'Mobile nav redesign', scopedPaths: [] });
    expect(desc).toContain('no concrete paths declared');
  });
});

describe('surface fix titles', () => {
  it('round-trips: surfaceFixTitle is recognized and its route read back', () => {
    const title = surfaceFixTitle('/app/tasks/:id', 'header overflows at 390px');
    expect(title).toBe('[surface fix] /app/tasks/:id: header overflows at 390px');
    expect(title.startsWith(SURFACE_FIX_TITLE_PREFIX)).toBe(true);
    expect(isSurfaceFixTask(title)).toBe(true);
    expect(surfaceFixRoute(title)).toBe('/app/tasks/:id');
  });

  it('reads the route when the pattern itself contains colons, and for the root route', () => {
    expect(surfaceFixRoute('[surface fix] /app/workspaces/:id/skills/:skillId: tabs clip')).toBe('/app/workspaces/:id/skills/:skillId');
    expect(surfaceFixRoute('[surface fix] /: hero CTA is dead')).toBe('/');
  });

  it('accepts the loose forms an agent writes (case, leading space, no route)', () => {
    expect(isSurfaceFixTask('  [Surface Fix] /app: x')).toBe(true);
    expect(surfaceFixRoute('[Surface Fix] /app/missions: x')).toBe('/app/missions');
    expect(surfaceFixRoute('[surface fix] the nav overlaps')).toBeNull();
  });

  it('does not flag audits or ordinary titles', () => {
    expect(isSurfaceFixTask(surfaceAuditTitle('M'))).toBe(false);
    expect(isSurfaceFixTask('Fix the surface of the nav')).toBe(false);
    expect(isSurfaceFixTask(null)).toBe(false);
  });
});

describe('surfaceAuditRound / round titles', () => {
  it('a first audit is round 1 and keeps the original title', () => {
    expect(surfaceAuditTitle('Mobile nav')).toBe('[surface audit] Mobile nav');
    expect(surfaceAuditRound({ title: '[surface audit] Mobile nav', context: null })).toBe(1);
  });

  it('a later round keeps the audit prefix, so every audit exclusion still applies', () => {
    const title = surfaceAuditTitle('Mobile nav', 2);
    expect(title).toBe('[surface audit] round 2: Mobile nav');
    expect(isSurfaceAuditTask(title)).toBe(true);
  });

  it('reads the round from context first, then from the title', () => {
    expect(surfaceAuditRound({ title: '[surface audit] Mobile nav', context: { surfaceAuditRound: 2 } })).toBe(2);
    expect(surfaceAuditRound({ title: '[surface audit] round 2: Mobile nav', context: {} })).toBe(2);
    // A mission literally named "round 5 ..." is not a round-5 audit.
    expect(surfaceAuditRound({ title: '[surface audit] round 5 planning', context: {} })).toBe(1);
    expect(surfaceAuditRound({ title: '[surface audit] M', context: { surfaceAuditRound: 'x' } })).toBe(1);
  });
});

describe('planSurfaceFixFollowUp — the round bound', () => {
  it('extends an audit that has not started: it will see the fix anyway', () => {
    expect(planSurfaceFixFollowUp({ status: 'pending', round: 1 })).toEqual({ action: 'extend' });
    expect(planSurfaceFixFollowUp({ status: 'pending', round: 2 })).toEqual({ action: 'extend' });
  });

  it('opens round 2 once round 1 has started or finished — the auditor files fixes while in_progress', () => {
    for (const status of ['assigned', 'in_progress', 'completed', 'failed']) {
      expect(planSurfaceFixFollowUp({ status, round: 1 })).toEqual({ action: 'new_round', round: 2 });
    }
  });

  it(`never opens round ${MAX_SURFACE_AUDIT_ROUNDS + 1}: issues after the last round go to a human`, () => {
    expect(MAX_SURFACE_AUDIT_ROUNDS).toBe(2);
    for (const status of ['in_progress', 'completed']) {
      expect(planSurfaceFixFollowUp({ status, round: MAX_SURFACE_AUDIT_ROUNDS })).toEqual({
        action: 'escalate',
        roundsRun: MAX_SURFACE_AUDIT_ROUNDS,
      });
    }
    // A bad round number can't loop past the cap either.
    expect(planSurfaceFixFollowUp({ status: 'completed', round: 7 }).action).toBe('escalate');
  });
});

describe('buildSurfaceAuditDescription — later rounds', () => {
  it('a round-2 description says what to re-check and that no round 3 follows', () => {
    const desc = buildSurfaceAuditDescription({
      missionTitle: 'Mobile nav',
      scopedPaths: [],
      requiredRoutes: ['/app/tasks/:id'],
      round: 2,
    });
    expect(desc).toContain('Round 2');
    expect(desc).toContain('- `/app/tasks/:id`');
    expect(desc).toContain('no round 3');
    expect(desc).toContain('[surface fix]');
  });

  it('a round-1 description does not mention rounds', () => {
    const desc = buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [], requiredRoutes: [] });
    expect(desc).not.toContain('Round ');
  });
});
