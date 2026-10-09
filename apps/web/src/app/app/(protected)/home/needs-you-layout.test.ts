import { describe, expect, it } from 'bun:test';
import { layoutNeedsYou, MAX_DECISION_CARDS, MAX_ROWS } from './needs-you-layout';
import type { HomeAttentionItem } from '@/lib/home-needs-you';

const item = (n: number, extra: Partial<HomeAttentionItem> = {}, ageHours = n): HomeAttentionItem => ({
  key: `k${n}`, kind: 'queue', label: 'review needed', tone: 'warning', title: `Change ${n}`,
  sentence: `Reason ${n}.`, meta: `PR #${n}`, href: `/pr/${n}`, actionType: 'review',
  primary: { label: 'Review PR', href: `/pr/${n}/files` },
  queue: { subjectKey: `s${n}`, chip: 'REVIEW', cardAgeHours: ageHours } as HomeAttentionItem['queue'],
  ...extra,
});

describe('Needs you at volume: a few decisions, then rows', () => {
  it('three or fewer are all decision cards', () => {
    const out = layoutNeedsYou([item(1), item(2), item(3)]);
    expect(out.cards).toHaveLength(3);
    expect(out.rows).toHaveLength(0);
  });

  it(`at most ${MAX_DECISION_CARDS} cards, oldest first; the rest are rows`, () => {
    const out = layoutNeedsYou([1, 2, 3, 4, 5, 6, 7, 8].map(n => item(n)));
    expect(out.cards.map(i => i.key)).toEqual(['k8', 'k7', 'k6']);
    expect(out.rows).toHaveLength(5);
    expect(out.total).toBe(8);
  });

  it('a systemic cause and a failure outrank an older review for a card', () => {
    const systemic = item(1, { systemic: { count: 3, subjects: ['a', 'b', 'c'] } }, 0);
    const failing = item(2, { tone: 'error', actionType: 'fix', label: 'tests failing' }, 0);
    const out = layoutNeedsYou([item(9), item(8), item(7), systemic, failing]);
    expect(out.cards.map(i => i.key)).toEqual(['k1', 'k2', 'k9']);
  });

  it('rows that ask the same thing fold into one group row', () => {
    const same = (n: number) => item(n, { sentence: 'Reviewer requested changes 3 times. Automated fix attempts exhausted.' }, 0);
    const out = layoutNeedsYou([item(10), item(11), item(12), same(1), same(2), same(3), same(4), item(5, {}, 0)]);
    const group = out.rows.find(r => r.kind === 'group');
    expect(group?.kind === 'group' && group.items.map(i => i.key)).toEqual(['k1', 'k2', 'k3', 'k4']);
    expect(group?.kind === 'group' && group.line).toBe('Reviewer requested changes 3 times.');
    expect(out.rows.filter(r => r.kind === 'single')).toHaveLength(1);
  });

  it(`more than ${MAX_ROWS} rows: the first ${MAX_ROWS} show, the rest wait behind Show all`, () => {
    const out = layoutNeedsYou(Array.from({ length: 3 + MAX_ROWS + 4 }, (_, i) => item(i + 1, { sentence: `Distinct ${i}.` })));
    expect(out.rows).toHaveLength(MAX_ROWS + 4);
    expect(out.hiddenRows).toBe(4);
  });
});
