import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { LEGACY_MANIFEST_ITEM, MANIFEST_ITEM } from '@/lib/checklist-text';

// The stored copy lives on the schedule template; sql fragments are flattened to
// their interpolated values so the test can see which checklist each write expects.
type Frag = { sql: true; values: unknown[] };
let rows: Array<{ id: string; heartbeatChecklist: string | null }> = [];
let predicates: unknown[] = [];
let writes: unknown[] = [];
let concurrentEdit = false;
const flat = (v: unknown): unknown => (Array.isArray(v) ? v.map(flat)
  : v && typeof v === 'object' && 'sql' in v ? (v as Frag).values.map(flat) : v);
mock.module('@buildd/core/db', () => ({ db: {
  select: () => ({ from: () => ({ where: async () => rows }) }),
  update: () => ({ set: (value: { taskTemplate: Frag }) => ({ where: (predicate: unknown) => ({ returning: async () => {
    predicates.push(flat(predicate));
    if (concurrentEdit) return [];
    const text = value.taskTemplate.values.at(-1) as string;
    writes.push(text);
    rows[0]!.heartbeatChecklist = text;
    return [{ id: rows[0]!.id }];
  } }) }) }),
} }));
mock.module('@buildd/core/db/schema', () => ({ taskSchedules: { id: 'id', taskTemplate: 'template' } }));
mock.module('drizzle-orm', () => ({
  eq: (a: unknown, b: unknown) => [a, b],
  and: (...args: unknown[]) => args,
  sql: (_s: TemplateStringsArray, ...values: unknown[]) => ({ sql: true, values }),
}));
const { repairMissionChecklists } = await import('./mission-checklists');
beforeEach(() => { rows = []; predicates = []; writes = []; concurrentEdit = false; });

describe('maintenance checklist repair', () => {
  it('updates verbatim copies once, counts custom copies, leaves null alone', async () => {
    rows = [
      { id: 'schedule-a', heartbeatChecklist: LEGACY_MANIFEST_ITEM },
      { id: 'schedule-b', heartbeatChecklist: 'custom checklist' },
      { id: 'schedule-c', heartbeatChecklist: null },
    ];
    expect(await repairMissionChecklists()).toEqual({ updated: 1, customized: 1, current: 0, raced: 0 });
    expect(predicates[0]).toEqual([['id', 'schedule-a'], [['template'], LEGACY_MANIFEST_ITEM]]);
    expect(writes).toEqual([MANIFEST_ITEM]);
    expect(await repairMissionChecklists()).toEqual({ updated: 0, customized: 1, current: 1, raced: 0 });
    expect(writes).toHaveLength(1);
  });
  it('does not overwrite a checklist edited since the read', async () => {
    rows = [{ id: 'schedule-a', heartbeatChecklist: LEGACY_MANIFEST_ITEM }];
    concurrentEdit = true;
    expect(await repairMissionChecklists()).toEqual({ updated: 0, customized: 0, current: 0, raced: 1 });
    expect(writes).toEqual([]);
  });
});
