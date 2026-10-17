import { describe, expect, it } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { labelDecisionOutcome, type OutcomeRow, type OutcomeStore } from '@buildd/core/decision-outcomes';
import {
  gradeSpecDecisions, noOutcomeFromSource, type SpecGradingStore, type UngradedAreaFiling, type UngradedDuplicate,
} from './spec-decision-grading';
import { SPEC_AREA_STAY_MS, SPEC_STOOD_MS } from './spec-decision-gold';

const t0 = new Date('2026-09-01T00:00:00Z');
const now = new Date(t0.getTime() + SPEC_STOOD_MS * 2);

/** An in-memory outcome store with the real (decision, source) uniqueness. */
function memoryOutcomes() {
  const rows = new Map<string, OutcomeRow>();
  const store: OutcomeStore = {
    async findRecords(q) { return q.decisionRecordId ? [{ id: q.decisionRecordId, capability: 'k' }] : []; },
    async insertOutcome(row) {
      const key = `${row.decisionRecordId}|${row.source}`;
      if (rows.has(key)) return false;
      rows.set(key, row);
      return true;
    },
    async readOutcome(id, source) {
      const r = rows.get(`${id}|${source}`);
      return r ? { label: r.label, value: r.value } : null;
    },
  };
  const label: typeof labelDecisionOutcome = (input) => labelDecisionOutcome(input, { store });
  return { rows, label };
}

const record = (o: Partial<UngradedDuplicate>): UngradedDuplicate => ({
  id: 'r1', teamId: 't', workspaceId: 'w', verdict: 'duplicate', subjectId: 'named:hash', createdAt: t0, override: null, ...o,
});

const store = (o: Partial<SpecGradingStore> & { dups?: UngradedDuplicate[]; filings?: UngradedAreaFiling[] }): SpecGradingStore => ({
  listUngradedDuplicates: async () => o.dups ?? [],
  findNewSpec: o.findNewSpec ?? (async () => null),
  findSupersededBy: o.findSupersededBy ?? (async () => null),
  listUngradedAreaFilings: async () => o.filings ?? [],
});

describe('gradeSpecDecisions: duplicate check', () => {
  it('labels an overridden refusal from its ledger row without looking for the spec', async () => {
    const m = memoryOutcomes();
    let looked = false;
    const res = await gradeSpecDecisions({ now }, {
      label: m.label,
      store: store({ dups: [record({ override: 'distinct' })], findNewSpec: async () => { looked = true; return null; } }),
    });
    expect(res.duplicate).toMatchObject({ scanned: 1, labelled: 1 });
    expect(looked).toBe(false);
    expect([...m.rows.values()]).toMatchObject([{ source: 'spec_duplicate_followup', label: 'distinct_override' }]);
  });

  it('labels a warned duplicate right once the named spec was superseded by the spec the check led to', async () => {
    const m = memoryOutcomes();
    const res = await gradeSpecDecisions({ now }, {
      label: m.label,
      store: store({
        dups: [record({})],
        findNewSpec: async (q) => (q.cardHash === 'hash' ? { id: 'new', createdAt: new Date(t0.getTime() + 2000) } : null),
        findSupersededBy: async (id) => (id === 'named' ? { id: 'new', createdAt: new Date(t0.getTime() + 2000), at: new Date(t0.getTime() + 9000) } : null),
      }),
    });
    expect(res.duplicate.labelled).toBe(1);
    expect([...m.rows.values()][0]).toMatchObject({ label: 'superseded', observedAt: new Date(t0.getTime() + 9000) });
  });

  it('labels a distinct verdict wrong when an older spec replaced the new one, and counts unknowns by reason', async () => {
    const m = memoryOutcomes();
    const res = await gradeSpecDecisions({ now }, {
      label: m.label,
      store: store({
        dups: [record({ id: 'a', verdict: 'distinct' }), record({ id: 'b', verdict: 'distinct', subjectId: 'x:other' })],
        findNewSpec: async (q) => (q.cardHash === 'hash' ? { id: 'new', createdAt: new Date(t0.getTime() + 2000) } : null),
        findSupersededBy: async () => ({ id: 'old', createdAt: new Date(t0.getTime() - 5000), at: new Date(t0.getTime() + 8000) }),
      }),
    });
    expect(res.duplicate).toMatchObject({ labelled: 1, unknown: { no_spec: 1 } });
    expect(m.rows.get('a|spec_duplicate_followup')?.label).toBe('superseded_later');
  });

  it('the first label stands: a later contradicting event is a conflict, not a rewrite', async () => {
    const m = memoryOutcomes();
    await gradeSpecDecisions({ now }, { label: m.label, store: store({ dups: [record({ override: 'duplicate_superseded' })] }) });
    const second = await gradeSpecDecisions({ now }, { label: m.label, store: store({ dups: [record({ override: 'distinct' })] }) });
    expect(second.duplicate).toMatchObject({ labelled: 0, conflicts: 1 });
    expect(m.rows.get('r1|spec_duplicate_followup')?.label).toBe('superseded');
    const again = await gradeSpecDecisions({ now }, { label: m.label, store: store({ dups: [record({ override: 'duplicate_superseded' })] }) });
    expect(again.duplicate).toMatchObject({ labelled: 0, duplicates: 1 });
  });

  it('a store that throws reports an error and does not throw', async () => {
    const res = await gradeSpecDecisions({ now }, { store: { ...store({}), listUngradedDuplicates: async () => { throw new Error('boom'); } } });
    expect(res.duplicate.errors).toBe(1);
    expect(res.area.errors).toBe(0);
  });
});

describe('gradeSpecDecisions: area filing', () => {
  const filing = (o: Partial<UngradedAreaFiling>): UngradedAreaFiling => ({
    decisionRecordId: 'f1', teamId: 't', kind: 'filed', status: 'applied', createdAt: t0, resolvedAt: null, filedParentId: 'a', currentParentId: 'a', ...o,
  });

  it('labels a moved filing wrong and a settled one right, in their own source', async () => {
    const m = memoryOutcomes();
    const res = await gradeSpecDecisions({ now: new Date(t0.getTime() + SPEC_AREA_STAY_MS) }, {
      label: m.label,
      store: store({ filings: [filing({ decisionRecordId: 'moved', status: 'overridden', resolvedAt: new Date(t0.getTime() + 5) }), filing({ decisionRecordId: 'kept' }), filing({ decisionRecordId: 'young', createdAt: new Date(t0.getTime() + 1000) })] }),
    });
    expect(res.area).toMatchObject({ scanned: 3, labelled: 2, unknown: { open: 1 } });
    expect(m.rows.get('moved|spec_area_followup')?.label).toBe('moved');
    expect(m.rows.get('kept|spec_area_followup')?.label).toBe('stayed');
  });
});

describe('the ungraded predicate', () => {
  it('renders as a correlated not-exists on the record id and the source', () => {
    const q = new PgDialect().sqlToQuery(noOutcomeFromSource('spec_area_followup'));
    expect(q.sql).toContain('not exists');
    expect(q.sql).toContain('decision_outcomes');
    expect(q.sql).toContain('o.decision_record_id = decision_records.id');
    expect(q.sql).toContain('o.source = $1');
    expect(q.params).toEqual(['spec_area_followup']);
  });
});
