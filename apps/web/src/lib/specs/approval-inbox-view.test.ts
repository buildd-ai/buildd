import { describe, expect, test } from 'bun:test';
import { sortByRisk } from './approval-inbox-view';

const row = (id: string, level: 'judgement' | 'low-risk') => ({ id, risk: { level, reasons: [] as string[] } });

describe('sortByRisk', () => {
  test('judgement first, low-risk after, each keeping its order, none dropped', () => {
    const out = sortByRisk([row('a', 'low-risk'), row('b', 'judgement'), row('c', 'low-risk'), row('d', 'judgement')]);
    expect(out.map((r) => r.id)).toEqual(['b', 'd', 'a', 'c']);
  });
});
