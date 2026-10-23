import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { LEGACY_MANIFEST_ITEM, MANIFEST_ITEM } from '@/lib/mission-checklist-repair';

let rows: Array<{ id: string; heartbeatChecklist: string | null }> = [];
let predicates: unknown[] = [];
let writes: unknown[] = [];
let concurrentEdit = false;
mock.module('@buildd/core/db', () => ({ db: {
  select: () => ({ from: async () => rows }),
  update: () => ({ set: (value: unknown) => ({ where: (predicate: unknown) => ({ returning: async () => {
    predicates.push(predicate);
    if (concurrentEdit) return [];
    writes.push(value);
    rows[0]!.heartbeatChecklist = (value as { heartbeatChecklist: string }).heartbeatChecklist;
    return [{ id: rows[0]!.id }];
  } }) }) }),
} }));
mock.module('@buildd/core/db/schema', () => ({ missions: { id: 'id', heartbeatChecklist: 'checklist' } }));
mock.module('drizzle-orm', () => ({ eq: (a: unknown, b: unknown) => [a, b], and: (...args: unknown[]) => args }));
const { repairMissionChecklists } = await import('./mission-checklists');
beforeEach(() => { rows = []; predicates = []; writes = []; concurrentEdit = false; });

describe('maintenance checklist repair', () => {
  it('updates verbatim copies once, counts custom copies, leaves null alone', async () => {
    rows = [
      { id: 'mission-a', heartbeatChecklist: LEGACY_MANIFEST_ITEM },
      { id: 'mission-b', heartbeatChecklist: 'custom checklist' },
      { id: 'mission-c', heartbeatChecklist: null },
    ];
    expect(await repairMissionChecklists()).toEqual({ updated: 1, customized: 1, current: 0, raced: 0 });
    expect(predicates[0]).toEqual([['id', 'mission-a'], ['checklist', LEGACY_MANIFEST_ITEM]]);
    expect(writes).toEqual([{ heartbeatChecklist: MANIFEST_ITEM }]);
    expect(await repairMissionChecklists()).toEqual({ updated: 0, customized: 1, current: 1, raced: 0 });
    expect(writes).toHaveLength(1);
  });
  it('does not overwrite a checklist edited since the read', async () => {
    rows = [{ id: 'mission-a', heartbeatChecklist: LEGACY_MANIFEST_ITEM }];
    concurrentEdit = true;
    expect(await repairMissionChecklists()).toEqual({ updated: 0, customized: 0, current: 0, raced: 1 });
    expect(writes).toEqual([]);
  });
});
