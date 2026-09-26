import { describe, it, expect } from 'bun:test';
import {
  routeForAppFile,
  routesForChangedFiles,
  requiredRoutes,
} from '../visual-qa-routes';

const APP = 'apps/web/src/app/';

describe('routeForAppFile', () => {
  const cases: Array<[string, string | null]> = [
    [`${APP}app/(protected)/tasks/[id]/page.tsx`, '/app/tasks/:id'],
    [`${APP}app/(protected)/missions/page.tsx`, '/app/missions'],
    [`${APP}app/(protected)/tasks/layout.tsx`, '/app/tasks'],
    [`${APP}app/(protected)/layout.tsx`, '/app'],
    [`${APP}layout.tsx`, '/'],
    [`${APP}page.tsx`, '/'],
    [`${APP}app/(protected)/team/[slug]/settings/page.tsx`, '/app/team/:slug/settings'],
    [`${APP}app/(protected)/settings/workspace/[workspaceId]/page.tsx`, '/app/settings/workspace/:workspaceId'],
    [`${APP}app/(protected)/workspaces/[id]/skills/[skillId]/page.tsx`, '/app/workspaces/:id/skills/:skillId'],
    [`${APP}share/[token]/page.tsx`, '/share/:token'],
    [`${APP}docs/[...slug]/page.tsx`, '/docs/:slug*'],
    [`${APP}docs/[[...slug]]/page.tsx`, '/docs/:slug*'],
    [`${APP}app/@modal/(protected)/inbox/page.tsx`, '/app/inbox'],
    [`${APP}app/(protected)/tasks/template.tsx`, '/app/tasks'],
    [`/${APP}app/(protected)/missions/page.tsx`, '/app/missions'],
    [`${APP}app/(protected)/missions/page.js`, '/app/missions'],
    // Not a route file.
    [`${APP}app/(protected)/missions/[id]/MissionDelivery.tsx`, null],
    [`${APP}app/(protected)/missions/loading.tsx`, null],
    // Route handlers are server-only.
    [`${APP}api/auth/[...nextauth]/route.ts`, null],
    [`${APP}api/tasks/page.tsx`, null],
    // Tests, other trees, globs and the advisory sentinel.
    [`${APP}app/(protected)/missions/page.test.tsx`, null],
    ['apps/web/src/components/TeamGrid.tsx', null],
    [`${APP}app/(protected)/tasks/**`, null],
    ['**', null],
    ['', null],
  ];
  for (const [input, expected] of cases) {
    it(`${JSON.stringify(input)} → ${expected}`, () => {
      expect(routeForAppFile(input)).toBe(expected);
    });
  }

  it('honours a custom appDir', () => {
    expect(routeForAppFile('src/app/(site)/about/page.tsx', 'src/app/')).toBe('/about');
    expect(routeForAppFile(`${APP}app/(protected)/missions/page.tsx`, 'src/app/')).toBeNull();
  });
});

describe('routesForChangedFiles', () => {
  it('maps, dedupes and sorts', () => {
    expect(
      routesForChangedFiles([
        `${APP}app/(protected)/tasks/[id]/page.tsx`,
        `${APP}app/(protected)/missions/page.tsx`,
        `${APP}app/(protected)/tasks/[id]/page.tsx`,
        `${APP}api/tasks/route.ts`,
      ]),
    ).toEqual(['/app/missions', '/app/tasks/:id']);
  });

  it('returns [] for no UI routes', () => {
    expect(routesForChangedFiles(['packages/core/db/schema.ts'])).toEqual([]);
  });
});

describe('requiredRoutes', () => {
  const manifest = {
    routes: [
      { id: 'home', path: '/app/home' },
      { id: 'missions', path: '/app/missions' },
      { id: 'mission-detail', path: '/app/missions/:id' },
      { id: 'tasks', path: '/app/tasks' },
      { id: 'task-detail', path: '/app/tasks/:id' },
    ],
  };

  it('a page gives only its own route, even with a manifest', () => {
    expect(requiredRoutes([`${APP}app/(protected)/missions/page.tsx`], manifest)).toEqual(['/app/missions']);
  });

  it('a layout also requires every manifest route under it', () => {
    expect(requiredRoutes([`${APP}app/(protected)/tasks/layout.tsx`], manifest)).toEqual([
      '/app/tasks',
      '/app/tasks/:id',
    ]);
  });

  it('a group layout fans out to the whole subtree, not a sibling prefix', () => {
    const wide = { routes: [...manifest.routes, { id: 'apples', path: '/apples' }] };
    expect(requiredRoutes([`${APP}app/(protected)/layout.tsx`], wide)).toEqual([
      '/app',
      '/app/home',
      '/app/missions',
      '/app/missions/:id',
      '/app/tasks',
      '/app/tasks/:id',
    ]);
  });

  it('the root layout fans out to every manifest route', () => {
    expect(requiredRoutes([`${APP}layout.tsx`], manifest)).toHaveLength(manifest.routes.length + 1);
  });

  it('works without a manifest', () => {
    expect(requiredRoutes([`${APP}app/(protected)/tasks/layout.tsx`])).toEqual(['/app/tasks']);
  });

  it('ignores a malformed manifest instead of throwing', () => {
    expect(requiredRoutes([`${APP}layout.tsx`], { routes: [null, { path: 3 }] } as any)).toEqual(['/']);
  });
});
