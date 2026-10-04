import { describe, expect, it } from 'bun:test';
import { labelDecisionOutcome, type OutcomeStore, type OutcomeRow } from '../decision-outcomes';

/**
 * Late outcome labels against immutable decision records. The decision row is
 * never touched; a label is its own row keyed (decision, source). Relabelling
 * with the same answer is a no-op, relabelling with a different one is a
 * conflict the caller sees, never a silent overwrite.
 */

interface Rec { id: string; teamId: string; capability: string; subjectType: string | null; subjectId: string | null }

function memoryStore(records: Rec[], opts: { failInsert?: boolean } = {}) {
  const outcomes: OutcomeRow[] = [];
  const store: OutcomeStore = {
    async findRecords(q) {
      return records
        .filter(r => r.teamId === q.teamId)
        .filter(r => (q.decisionRecordId ? r.id === q.decisionRecordId : true))
        .filter(r => (q.capability ? r.capability === q.capability : true))
        .filter(r => (q.subject ? r.subjectType === q.subject.type && r.subjectId === q.subject.id : true))
        .map(r => ({ id: r.id, capability: r.capability }));
    },
    async insertOutcome(row) {
      if (opts.failInsert) throw new Error('db down');
      if (outcomes.some(o => o.decisionRecordId === row.decisionRecordId && o.source === row.source)) return false;
      outcomes.push(row);
      return true;
    },
    async readOutcome(decisionRecordId, source) {
      const o = outcomes.find(x => x.decisionRecordId === decisionRecordId && x.source === source);
      return o ? { label: o.label, value: o.value } : null;
    },
  };
  return { store, outcomes };
}

const RECS: Rec[] = [
  { id: 'd1', teamId: 't1', capability: 'buildd.probe', subjectType: 'task', subjectId: 'task-1' },
  { id: 'd2', teamId: 't1', capability: 'buildd.probe', subjectType: 'task', subjectId: 'task-1' },
  { id: 'd3', teamId: 't1', capability: 'buildd.other', subjectType: 'task', subjectId: 'task-1' },
  { id: 'd4', teamId: 't2', capability: 'buildd.probe', subjectType: 'task', subjectId: 'task-9' },
];
const at = new Date('2026-10-03T12:00:00Z');

describe('labelDecisionOutcome', () => {
  it('records one label against one decision', async () => {
    const { store, outcomes } = memoryStore(RECS);
    const res = await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd1', source: 'task_terminal', label: 'correct', value: 1, observedAt: at }, { store });
    expect(res).toEqual({ ok: true, results: [{ decisionRecordId: 'd1', status: 'recorded' }] });
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({ decisionRecordId: 'd1', teamId: 't1', capability: 'buildd.probe', source: 'task_terminal', label: 'correct', value: 1, observedAt: at, metadata: null });
  });

  it('is idempotent: the same label again is a duplicate and writes nothing', async () => {
    const { store, outcomes } = memoryStore(RECS);
    const input = { teamId: 't1', decisionRecordId: 'd1', source: 'task_terminal', label: 'correct', value: 1, observedAt: at };
    await labelDecisionOutcome(input, { store });
    const again = await labelDecisionOutcome({ ...input, observedAt: new Date('2026-10-04T00:00:00Z') }, { store });
    expect(again).toEqual({ ok: true, results: [{ decisionRecordId: 'd1', status: 'duplicate' }] });
    expect(outcomes).toHaveLength(1);
  });

  it('a different label for the same (decision, source) is a conflict; the first label stands', async () => {
    const { store, outcomes } = memoryStore(RECS);
    await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd1', source: 'task_terminal', label: 'correct', observedAt: at }, { store });
    const res = await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd1', source: 'task_terminal', label: 'wrong', observedAt: at }, { store });
    expect(res).toEqual({ ok: true, results: [{ decisionRecordId: 'd1', status: 'conflict', existing: { label: 'correct', value: null } }] });
    expect(outcomes.map(o => o.label)).toEqual(['correct']);
  });

  it('another source may label the same decision independently', async () => {
    const { store, outcomes } = memoryStore(RECS);
    await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd1', source: 'task_terminal', label: 'correct', observedAt: at }, { store });
    const res = await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd1', source: 'human', label: 'wrong', observedAt: at }, { store });
    expect(res.ok && res.results[0].status).toBe('recorded');
    expect(outcomes).toHaveLength(2);
  });

  it('labels every record of one kind for a subject, and only that kind', async () => {
    const { store, outcomes } = memoryStore(RECS);
    const res = await labelDecisionOutcome({
      teamId: 't1', capability: 'buildd.probe', subject: { type: 'task', id: 'task-1' }, source: 'task_terminal', label: 'merged', observedAt: at,
    }, { store });
    expect(res.ok && res.results.map(r => [r.decisionRecordId, r.status])).toEqual([['d1', 'recorded'], ['d2', 'recorded']]);
    expect(outcomes.map(o => o.decisionRecordId)).toEqual(['d1', 'd2']);
  });

  it('never labels another team\'s decision', async () => {
    const { store, outcomes } = memoryStore(RECS);
    const res = await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd4', source: 'human', label: 'wrong', observedAt: at }, { store });
    expect(res).toEqual({ ok: false, error: 'not_found' });
    expect(outcomes).toHaveLength(0);
  });

  it('refuses a request that names neither a decision nor a kind+subject, or has no source/label', async () => {
    const { store } = memoryStore(RECS);
    expect(await labelDecisionOutcome({ teamId: 't1', source: 'x', label: 'y' } as never, { store })).toEqual({ ok: false, error: 'invalid' });
    expect(await labelDecisionOutcome({ teamId: 't1', subject: { type: 'task', id: 'task-1' }, source: 'x', label: 'y' } as never, { store })).toEqual({ ok: false, error: 'invalid' });
    expect(await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd1', source: '', label: 'y' }, { store })).toEqual({ ok: false, error: 'invalid' });
    expect(await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd1', source: 'x', label: ' ' }, { store })).toEqual({ ok: false, error: 'invalid' });
  });

  it('never throws: a store failure is an error result', async () => {
    const { store } = memoryStore(RECS, { failInsert: true });
    expect(await labelDecisionOutcome({ teamId: 't1', decisionRecordId: 'd1', source: 'human', label: 'x', observedAt: at }, { store })).toEqual({ ok: false, error: 'store_failed' });
  });
});
