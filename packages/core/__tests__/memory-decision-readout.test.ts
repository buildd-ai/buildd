import { describe, expect, it } from 'bun:test';
import { computeMemoryDecisionReadout, formatMemoryDecisionReadout, type ReadoutDecisionRow } from '../memory-decision-readout';

const row = (o: Partial<ReadoutDecisionRow> & { decision: string }): ReadoutDecisionRow => ({
  taskId: null, memoryId: null, verdict: null, confidence: null, rule: null, applied: false, error: null, ...o,
});

describe('computeMemoryDecisionReadout', () => {
  it('relevance: rule precision vs Jev precision and recall on the ledger outcome', () => {
    const rows = [
      row({ decision: 'relevance', taskId: 't1', memoryId: 'a', verdict: 'true', confidence: 0.9, rule: 'shown' }),
      row({ decision: 'relevance', taskId: 't1', memoryId: 'b', verdict: 'false', confidence: 0.8, rule: 'shown' }),
      row({ decision: 'relevance', taskId: 't2', memoryId: 'a', verdict: 'true', confidence: 0.6, rule: 'shown' }),
      row({ decision: 'relevance', taskId: 't3', memoryId: 'c', error: 'timeout' }),
    ];
    const outcomes = [
      { taskId: 't1', memoryId: 'a', outcome: 'used' as const },
      { taskId: 't1', memoryId: 'b', outcome: 'ignored' as const },
      { taskId: 't2', memoryId: 'a', outcome: 'ignored' as const },
    ];
    const [s] = computeMemoryDecisionReadout(rows, outcomes);
    expect(s).toMatchObject({ decision: 'relevance', rows: 4, answered: 3, errors: { timeout: 1 } });
    expect(s.agreeWithRule).toBeCloseTo(2 / 3);
    expect(s.ledger!.rulePrecision).toEqual({ used: 1, graded: 3, rate: 1 / 3 });
    expect(s.ledger!.jevPrecision).toEqual({ used: 1, graded: 2, rate: 0.5 });
    expect(s.ledger!.jevRecall).toBe(1);
    expect(s.coverage['0.8']).toBeCloseTo(2 / 3);
  });

  it('keep and type split the memory use rate by verdict', () => {
    const rows = [
      row({ decision: 'keep', memoryId: 'a', verdict: 'false', confidence: 0.9, rule: 'keep', applied: true }),
      row({ decision: 'keep', memoryId: 'b', verdict: 'true', confidence: 0.9, rule: 'keep' }),
      row({ decision: 'type', memoryId: 'a', verdict: 'pattern', confidence: 0.95, rule: 'gotcha', applied: true }),
      row({ decision: 'type', memoryId: 'b', verdict: 'gotcha', confidence: 0.99, rule: 'gotcha' }),
    ];
    const outcomes = [
      { taskId: 't1', memoryId: 'a', outcome: 'ignored' as const },
      { taskId: 't2', memoryId: 'a', outcome: 'ignored' as const },
      { taskId: 't1', memoryId: 'b', outcome: 'used' as const },
    ];
    const out = computeMemoryDecisionReadout(rows, outcomes);
    const keep = out.find(s => s.decision === 'keep')!;
    expect(keep.ledger!.flagged).toEqual({ used: 0, graded: 2, rate: 0 });
    expect(keep.ledger!.kept).toEqual({ used: 1, graded: 1, rate: 1 });
    const type = out.find(s => s.decision === 'type')!;
    expect(type.agreeWithRule).toBe(0.5);
    expect(type.applied).toBe(1);
  });

  it('formats an empty window without throwing', () => {
    expect(formatMemoryDecisionReadout([])).toContain('No memory decisions');
    const text = formatMemoryDecisionReadout(computeMemoryDecisionReadout([row({ decision: 'update', verdict: 'NOOP', confidence: 0.9, rule: 'conflict', applied: true })], []));
    expect(text).toContain('## update');
    expect(text).toContain('NOOP 1');
  });
});
