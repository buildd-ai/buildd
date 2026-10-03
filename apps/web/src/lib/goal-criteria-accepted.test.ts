import { describe, expect, it } from 'bun:test';
import { criterionFingerprint } from '@buildd/core/mission-helpers';
import {
  acceptedPatternCandidates,
  recordAcceptedGoalCriteriaPatterns,
  type AcceptedPatternStore,
  type CompletedMissionFacts,
} from './goal-criteria-accepted';

const MISSION = '11111111-2222-4333-8444-555555555555';
const kept = { type: 'command' as const, command: 'bun run scripts/private-check.ts', label: 'billing export matches the ledger' };
const other = { type: 'command' as const, command: 'bun run e2e signup', label: 'a visitor can sign up' };
const FP = criterionFingerprint(kept);

const mission = (over: Partial<CompletedMissionFacts> = {}): CompletedMissionFacts => ({
  id: MISSION,
  teamId: 'team-1',
  workspaceId: 'ws-1',
  status: 'completed',
  goalCriteria: [other, kept],
  goalCriteriaState: { overall: 'pass' } as any,
  criteriaEscalatedAt: null,
  ...over,
});

describe('acceptedPatternCandidates (pure)', () => {
  it('a bypassed criterion on a clean completion qualifies', () => {
    expect(acceptedPatternCandidates(mission(), [FP])).toEqual([{ criterion: kept, fingerprint: FP }]);
  });

  it('nothing qualifies unless completed, passing and never escalated', () => {
    expect(acceptedPatternCandidates(mission({ status: 'active' }), [FP])).toEqual([]);
    expect(acceptedPatternCandidates(mission({ goalCriteriaState: { overall: 'UNVERIFIED' } as any }), [FP])).toEqual([]);
    expect(acceptedPatternCandidates(mission({ goalCriteriaState: null }), [FP])).toEqual([]);
    expect(acceptedPatternCandidates(mission({ criteriaEscalatedAt: new Date() }), [FP])).toEqual([]);
  });

  it('a bypassed criterion no longer in the final goal does not qualify; duplicates collapse', () => {
    expect(acceptedPatternCandidates(mission({ goalCriteria: [other] }), [FP])).toEqual([]);
    expect(acceptedPatternCandidates(mission({ goalCriteria: [kept, kept] }), [FP, FP])).toHaveLength(1);
  });
});

function memoryStore(existing: Array<{ id: string; tags: string[] }> = []) {
  const saved: any[] = [];
  const updated: any[] = [];
  const searches: any[] = [];
  const store: AcceptedPatternStore = {
    async search(p) {
      searches.push(p);
      return { results: existing.filter(e => !p.tag || e.tags.includes(p.tag)) as any };
    },
    async save(input) { saved.push(input); return {}; },
    async update(id, fields) { updated.push({ id, fields }); return {}; },
  };
  return { store, saved, updated, searches };
}

const deps = (s: ReturnType<typeof memoryStore>, over: Record<string, unknown> = {}) => ({
  loadMission: async () => mission(),
  loadBypassed: async () => [FP],
  resolveProject: async () => 'acme/app',
  store: () => s.store,
  ...over,
});

describe('recordAcceptedGoalCriteriaPatterns', () => {
  it('saves one workspace-scoped pattern describing the shape, with no criterion text or ids', async () => {
    const s = memoryStore();
    expect(await recordAcceptedGoalCriteriaPatterns(MISSION, deps(s))).toBe(1);
    expect(s.saved).toHaveLength(1);
    const m = s.saved[0];
    expect(m).toMatchObject({ type: 'pattern', project: 'acme/app', sourceKind: 'mission_completion' });
    expect(m.tags).toEqual(['goal-criteria-rubric', 'goal-criteria-accepted', `fp:${FP}`]);
    for (const text of ['private-check', 'billing export', MISSION, 'ws-1', 'team-1']) {
      expect(`${m.title} ${m.content}`).not.toContain(text);
    }
  });

  it('recalls before saving: an existing row for the fingerprint is updated, not duplicated', async () => {
    const s = memoryStore([{ id: 'mem-1', tags: ['goal-criteria-accepted', `fp:${FP}`] }]);
    await recordAcceptedGoalCriteriaPatterns(MISSION, deps(s));
    expect(s.saved).toEqual([]);
    expect(s.updated).toHaveLength(1);
    expect(s.updated[0].id).toBe('mem-1');
    expect(s.searches[0]).toMatchObject({ type: 'pattern', project: 'acme/app', tag: `fp:${FP}` });
  });

  it('a sensitive or unscoped workspace writes nothing', async () => {
    const s = memoryStore();
    expect(await recordAcceptedGoalCriteriaPatterns(MISSION, deps(s, { resolveProject: async () => null }))).toBe(0);
    expect(s.saved).toEqual([]);
  });

  it('no bypassed rows, or an unclean completion, writes nothing and reads no memory', async () => {
    const s = memoryStore();
    await recordAcceptedGoalCriteriaPatterns(MISSION, deps(s, { loadBypassed: async () => [] }));
    await recordAcceptedGoalCriteriaPatterns(MISSION, deps(s, { loadMission: async () => mission({ criteriaEscalatedAt: new Date() }) }));
    expect(s.searches).toEqual([]);
    expect(s.saved).toEqual([]);
  });

  it('never throws: a failing read or write returns what got through', async () => {
    const s = memoryStore();
    await expect(recordAcceptedGoalCriteriaPatterns(MISSION, deps(s, { loadMission: async () => { throw new Error('db down'); } }))).resolves.toBe(0);
    const failing = { ...s.store, save: async () => { throw new Error('write failed'); } };
    await expect(recordAcceptedGoalCriteriaPatterns(MISSION, deps(s, { store: () => failing }))).resolves.toBe(0);
  });
});
