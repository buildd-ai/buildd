import { describe, it, expect } from 'bun:test';
import {
  dependencyHoldsTask,
  MAX_SURFACE_AUDIT_ROUNDS,
  MAX_TOTAL_SURFACE_AUDIT_ROUNDS,
  SURFACE_AUDIT_THEMES,
  SURFACE_AUDIT_TITLE_PREFIX,
  missingThemeCells,
  parseSurfaceAuditTheme,
  SURFACE_FIX_TITLE_PREFIX,
  buildSurfaceAuditDescription,
  isSurfaceAuditTask,
  isSurfaceFixTask,
  isUiSurfacePath,
  isRenderedSurfaceChange,
  surfaceAuditMissingReason,
  surfaceAuditHeadline,
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

describe('dependencyHoldsTask — an audit waits on current mission members only', () => {
  const audit = { title: '[surface audit] Mobile nav', missionId: 'm-1' };
  it('a member dependency holds the audit', () => {
    expect(dependencyHoldsTask(audit, { missionId: 'm-1' })).toBe(true);
  });
  it('a dependency unlinked, moved or gone does not', () => {
    expect(dependencyHoldsTask(audit, { missionId: null })).toBe(false);
    expect(dependencyHoldsTask(audit, { missionId: 'm-2' })).toBe(false);
    expect(dependencyHoldsTask(audit, undefined)).toBe(false);
  });
  it('an ordinary task is held by every dependency it names', () => {
    expect(dependencyHoldsTask({ title: 'Build the card', missionId: 'm-1' }, { missionId: 'm-2' })).toBe(true);
    expect(dependencyHoldsTask({ title: '[surface audit] x', missionId: null }, { missionId: 'm-2' })).toBe(true);
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

  it('asks for a QA_PLAN state per modal/menu/gated state, and a fixture task behind every unsure', () => {
    const desc = buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [] });
    expect(desc).toContain('write a QA_PLAN state');
    expect(desc).toContain('never commit');
    expect(desc).toContain('add a ?state= fixture for <state>');
    expect(desc).toContain('An unsure shot with no follow-up task is not done');
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

describe('buildSurfaceAuditDescription — the standard visual checks, every workspace', () => {
  const desc = buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [], requiredRoutes: ['/app/missions'] });

  it('requires both themes, by color-scheme emulation, recorded as qa.theme', () => {
    expect(desc).toContain('light AND dark');
    expect(desc).toContain('prefers-color-scheme');
    expect(desc).toContain('qa.theme');
    expect(desc).toContain('both themes');
  });

  it('checks the first screen at 390 says what the page is for', () => {
    expect(desc).toContain('First screen at 390');
    expect(desc).toContain('without scrolling');
  });

  it('checks nothing is shown twice, beyond duplicate chrome titles', () => {
    expect(desc).toContain('Nothing shown twice');
    expect(desc).toContain('same fact, count or action');
    expect(desc).toContain('duplicate chrome titles');
  });

  it('asks for a before shot from the base ref when the mission is on a branch', () => {
    expect(desc).toContain('Before/after');
    expect(desc).toContain('mission_integration');
    expect(desc).toContain('what changed');
  });

  it('says nothing about design rules or a reference when the workspace set neither', () => {
    expect(desc).not.toContain('Design rules');
    expect(desc).not.toContain('Design reference');
    expect(buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [], visualQa: { designRules: null, reference: null } })).toBe(
      buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [] }),
    );
  });
});

describe('buildSurfaceAuditDescription — workspace-provided design rules and reference', () => {
  it('a designRules path adds a check of every shot against it, and tells the auditor to read it', () => {
    const desc = buildSurfaceAuditDescription({
      missionTitle: 'M',
      scopedPaths: [],
      visualQa: { designRules: 'docs/design/design-system.md' },
    });
    expect(desc).toContain('check each shot against `docs/design/design-system.md`');
    expect(desc).toContain('Read `docs/design/design-system.md`');
    expect(desc).not.toContain('Design reference');
  });

  it('a reference makes findings compare against it', () => {
    const desc = buildSurfaceAuditDescription({
      missionTitle: 'M',
      scopedPaths: [],
      visualQa: { reference: 'refined-ui-prototype' },
    });
    expect(desc).toContain('Design reference');
    expect(desc).toContain('`refined-ui-prototype`');
    expect(desc).toContain('compare');
    expect(desc).not.toContain('check each shot against');
  });

  it('a URL reference is named as a URL, an id as an artifact', () => {
    expect(buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [], visualQa: { reference: 'https://example.com/proto' } }))
      .toContain('https://example.com/proto');
    expect(buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [], visualQa: { reference: 'abc' } }))
      .toContain('get_artifact');
  });
});

describe('surface audit theme coverage', () => {
  it('parses a theme loosely and drops anything else', () => {
    expect(SURFACE_AUDIT_THEMES).toEqual(['light', 'dark']);
    expect(parseSurfaceAuditTheme('Dark ')).toBe('dark');
    expect(parseSurfaceAuditTheme('light')).toBe('light');
    expect(parseSurfaceAuditTheme('sepia')).toBeNull();
    expect(parseSurfaceAuditTheme(undefined)).toBeNull();
  });

  it('a route is covered only with a shot in each theme', () => {
    expect(missingThemeCells(['/a'], [{ route: '/a', theme: 'dark' }, { route: '/a', theme: 'light' }])).toEqual([]);
    expect(missingThemeCells(['/a'], [{ route: '/a', theme: 'dark' }])).toEqual(['/a @ light theme']);
  });

  it('a shot with no theme counts toward neither', () => {
    expect(missingThemeCells(['/a'], [{ route: '/a' }, { route: '/a', theme: null }])).toEqual(['/a @ light theme', '/a @ dark theme']);
  });

  it('matches routes with the caller\'s pattern rule', () => {
    const covers = (pattern: string, route: string) => pattern === '/t/:id' ? route.startsWith('/t/') : pattern === route;
    expect(missingThemeCells(['/t/:id'], [{ route: '/t/1', theme: 'light' }, { route: '/t/2', theme: 'dark' }], covers)).toEqual([]);
    expect(missingThemeCells(['/t/:id', '/b'], [{ route: '/b', theme: 'light' }], covers)).toEqual([
      '/t/:id @ light theme', '/t/:id @ dark theme', '/b @ dark theme',
    ]);
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

describe('planSurfaceFixFollowUp — human-origin fixes (visual-qa-human-review.md, Rounds)', () => {
  const human = { origin: 'human' as const };

  it('defaults to the automatic rules', () => {
    expect(planSurfaceFixFollowUp({ status: 'completed', round: 2 })).toEqual(
      planSurfaceFixFollowUp({ status: 'completed', round: 2 }, { origin: 'auto' }),
    );
  });

  it('bypasses the automatic cap: a human fix after the last automatic round opens the next round', () => {
    expect(planSurfaceFixFollowUp({ status: 'completed', round: MAX_SURFACE_AUDIT_ROUNDS }, human)).toEqual({
      action: 'new_round',
      round: MAX_SURFACE_AUDIT_ROUNDS + 1,
    });
    expect(planSurfaceFixFollowUp({ status: 'in_progress', round: 1 }, human)).toEqual({ action: 'new_round', round: 2 });
  });

  it('keeps one open human round: a second request while a round is still pending extends it', () => {
    expect(planSurfaceFixFollowUp({ status: 'pending', round: 3 }, human)).toEqual({ action: 'extend' });
    expect(planSurfaceFixFollowUp({ status: 'pending', round: 1 }, human)).toEqual({ action: 'extend' });
  });

  it(`stops at the ceiling of ${MAX_TOTAL_SURFACE_AUDIT_ROUNDS} rounds in all`, () => {
    expect(MAX_TOTAL_SURFACE_AUDIT_ROUNDS).toBe(5);
    expect(planSurfaceFixFollowUp({ status: 'completed', round: MAX_TOTAL_SURFACE_AUDIT_ROUNDS - 1 }, human)).toEqual({
      action: 'new_round',
      round: MAX_TOTAL_SURFACE_AUDIT_ROUNDS,
    });
    expect(planSurfaceFixFollowUp({ status: 'completed', round: MAX_TOTAL_SURFACE_AUDIT_ROUNDS }, human)).toEqual({
      action: 'ceiling',
      roundsRun: MAX_TOTAL_SURFACE_AUDIT_ROUNDS,
    });
    // Even a pending audit past the ceiling is only extended, never a new round.
    expect(planSurfaceFixFollowUp({ status: 'pending', round: MAX_TOTAL_SURFACE_AUDIT_ROUNDS }, human)).toEqual({ action: 'extend' });
  });

  it('an automatic fix filed during a human round still goes to a human, naming the real round', () => {
    expect(planSurfaceFixFollowUp({ status: 'in_progress', round: 3 }, { origin: 'auto' })).toEqual({
      action: 'escalate',
      roundsRun: 3,
    });
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

  it('a human-opened round says so, and tells the auditor to report prior-finding resolution', () => {
    const desc = buildSurfaceAuditDescription({
      missionTitle: 'M',
      scopedPaths: [],
      requiredRoutes: ['/app/tasks/:id'],
      round: 3,
      trigger: 'human',
    });
    expect(desc).toContain('Round 3');
    expect(desc).toContain('opened by a human review');
    expect(desc).toContain('Resolved:');
    expect(desc).not.toContain('no round 4');
  });

  it('a round-1 description does not mention rounds', () => {
    const desc = buildSurfaceAuditDescription({ missionTitle: 'M', scopedPaths: [], requiredRoutes: [] });
    expect(desc).not.toContain('Round ');
  });
});

describe('isRenderedSurfaceChange', () => {
  it('matches UI source files', () => {
    expect(isRenderedSurfaceChange('apps/web/src/components/Card.tsx')).toBe(true);
    expect(isRenderedSurfaceChange('apps/web/src/app/app/(protected)/team/page.tsx')).toBe(true);
  });

  it('ignores API routes, tests, stories, snapshots and docs', () => {
    expect(isRenderedSurfaceChange('apps/web/src/app/api/tasks/route.ts')).toBe(false);
    expect(isRenderedSurfaceChange('apps/web/src/components/Card.test.tsx')).toBe(false);
    expect(isRenderedSurfaceChange('apps/web/src/components/Card.stories.tsx')).toBe(false);
    expect(isRenderedSurfaceChange('apps/web/src/components/__tests__/x.tsx')).toBe(false);
    expect(isRenderedSurfaceChange('apps/web/src/app/notes.md')).toBe(false);
  });

  it('ignores files outside the UI directories', () => {
    expect(isRenderedSurfaceChange('packages/core/db/schema.ts')).toBe(false);
  });
});

describe('surfaceAuditMissingReason', () => {
  it('names the files, the evidence, and both ways out', () => {
    const r = surfaceAuditMissingReason(['a/one.tsx', 'a/two.tsx'], 'diff');
    expect(r).toContain('its merged PRs changed a/one.tsx, a/two.tsx');
    expect(r).toContain('[surface audit]');
    expect(r).toContain('surfaceAuditWaiver');
  });

  it('caps the list and says how many more', () => {
    const r = surfaceAuditMissingReason(['1', '2', '3', '4', '5'], 'manifest');
    expect(r).toContain('its tasks declare 1, 2, 3 and 2 more');
  });
});

describe('surfaceAuditHeadline', () => {
  it('is one plain sentence with the file count and no API or tool names', () => {
    expect(surfaceAuditHeadline(9)).toBe('This mission changed 9 UI files and no visual audit has run.');
    expect(surfaceAuditHeadline(1)).toBe('This mission changed 1 UI file and no visual audit has run.');
    for (const n of [0, 1, 9]) expect(surfaceAuditHeadline(n)).not.toMatch(/surfaceAuditWaiver|manage_missions|\[surface audit\]/);
  });

  it('does not claim a count when the files are unknown', () => {
    expect(surfaceAuditHeadline(0)).toBe('This mission changed UI and no visual audit has run.');
  });
});
