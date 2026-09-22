import { describe, it, expect, mock } from 'bun:test';

let selectRows: Array<{ id: string; missionId: string | null; createdAt: string }> = [];
let lastWhere: unknown = null;

mock.module('drizzle-orm', () => ({
  and: (...args: any[]) => ({ _op: 'and', args }),
  eq: (...args: any[]) => ({ _op: 'eq', args }),
  inArray: (...args: any[]) => ({ _op: 'inArray', args }),
}));

mock.module('@buildd/core/db/schema', () => ({
  missionNotes: { id: 'id', missionId: 'missionId', createdAt: 'createdAt', authorType: 'authorType' },
}));

mock.module('@buildd/core/db', () => ({
  db: {
    select: () => ({
      from: () => ({
        where: (w: unknown) => {
          lastWhere = w;
          return Promise.resolve(selectRows);
        },
      }),
    }),
  },
}));

import { loadHumanSteeringMarksByMission } from './mission-steering-notes';

describe('loadHumanSteeringMarksByMission', () => {
  it('returns an empty map with no query when given no mission ids', async () => {
    lastWhere = null;
    const result = await loadHumanSteeringMarksByMission([]);
    expect(result.size).toBe(0);
    expect(lastWhere).toBeNull();
  });

  it('groups rows by missionId as human steering events', async () => {
    selectRows = [
      { id: 'n1', missionId: 'm1', createdAt: '2026-01-01T00:00:00Z' },
      { id: 'n2', missionId: 'm1', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'n3', missionId: 'm2', createdAt: '2026-01-03T00:00:00Z' },
    ];
    const result = await loadHumanSteeringMarksByMission(['m1', 'm2']);

    expect(result.get('m1')).toEqual([
      { id: 'n1', kind: 'human', at: '2026-01-01T00:00:00Z' },
      { id: 'n2', kind: 'human', at: '2026-01-02T00:00:00Z' },
    ]);
    expect(result.get('m2')).toEqual([{ id: 'n3', kind: 'human', at: '2026-01-03T00:00:00Z' }]);
  });

  it('drops a row with no missionId rather than crashing', async () => {
    selectRows = [{ id: 'n1', missionId: null, createdAt: '2026-01-01T00:00:00Z' }];
    const result = await loadHumanSteeringMarksByMission(['m1']);
    expect(result.get('m1')).toBeUndefined();
  });
});
