import { describe, it, expect } from 'bun:test';
import { CHAT_ROUTES } from './in-process-api';
import { routeReachProblems, SCOPE_FIELDS } from './reach-rules';

/**
 * The CI guard for chat reach: every route a chat tool can reach declares how
 * its target and result map to a workspace or team. A new route added to
 * CHAT_ROUTES without one fails here instead of reaching everything.
 */
describe('every chat route declares its reach', () => {
  for (const route of CHAT_ROUTES) {
    it(`${route.methods.join(',')} ${route.pattern}`, () => {
      expect(routeReachProblems(route)).toEqual([]);
    });
  }
});

describe('routeReachProblems (the checker itself can fail)', () => {
  it('flags a route with no declaration', () => {
    expect(routeReachProblems({ pattern: '/api/x', methods: ['GET'] } as any)).toEqual(['/api/x: no reach declaration']);
  });
  it('flags a path param with no target', () => {
    expect(routeReachProblems({ pattern: '/api/x/:id', methods: ['GET'], reach: { pinTeam: true, result: 'rows' } }))
      .toContain('/api/x/:id: path param :id has no reach target');
  });
  it('flags a route nothing pins', () => {
    expect(routeReachProblems({ pattern: '/api/x', methods: ['GET'], reach: { result: 'rows' } })[0]).toContain('nothing pins its scope');
  });
  it('an unpinned route needs a reason and must be read-only', () => {
    expect(routeReachProblems({ pattern: '/api/x', methods: ['GET'], reach: { unpinned: 'x', result: 'rows' } })).toContain('/api/x: unpinned needs a reason');
    expect(routeReachProblems({ pattern: '/api/x', methods: ['POST'], reach: { unpinned: 'a long enough reason', result: 'rows' } }))
      .toContain("/api/x: a write route can't be unpinned");
  });
});

describe('scope fields', () => {
  it('cover every id a body or query can use to point at another object', () => {
    for (const f of ['workspaceId', 'teamId', 'taskId', 'missionId', 'parentTaskId', 'dependsOn', 'initiativeId', 'workerId']) {
      expect(Object.keys(SCOPE_FIELDS)).toContain(f);
    }
  });
});
