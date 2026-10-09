import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ useRouter: () => ({ refresh() {} }), usePathname: () => '/app/home', useSearchParams: () => new URLSearchParams() }));
const { HomeBody } = await import('./HomeBody');
import type { HomeAttentionItem } from '@/lib/home-needs-you';

const item = (n: number, sentence = `Reason ${n}.`): HomeAttentionItem => ({
  key: `k${n}`, kind: 'queue', label: 'review needed', tone: 'warning', title: `Change ${n}`,
  sentence, meta: `PR #${n}`, href: `/pr/${n}`, actionType: 'review',
  primary: { label: 'Review PR', href: `/pr/${n}/files` },
  queue: { subjectKey: `s${n}`, chip: 'REVIEW', cardAgeHours: n } as HomeAttentionItem['queue'],
});
const counts = { openMissions: 0, executingMissions: 0, liveAgents: 0, slots: { used: 0, total: 0 } };
const render = (items: HomeAttentionItem[], inProgress = 0) =>
  renderToStaticMarkup(<HomeBody items={items} ask={null} counts={counts} milestones={[]} quietMissions={0} inProgress={inProgress} />);

// Owner, 2026-10-09: twenty decisions as a three-across wall of tall boxes is
// unreadable. A few genuine decisions get the L3 card; the rest are hairline rows.
describe('Home with many decisions', () => {
  it('three cards, then rows with one text action each; the headline still counts all', () => {
    const html = render([1, 2, 3, 4, 5, 6, 7, 8].map(n => item(n)));
    expect(html.match(/data-testid="needs-you-card"/g)).toHaveLength(3);
    expect(html.match(/data-testid="needs-you-row"/g)).toHaveLength(5);
    expect(html).toContain('8 things need you.');
    const rows = html.slice(html.indexOf('data-testid="needs-you-rows"'));
    expect(rows).not.toMatch(/class="[^"]*\bbtn\b/);
    expect(rows).not.toContain('card-decision');
    expect(rows).toContain('href="/pr/1/files"');
  });

  it('rows asking the same thing are one group row with the count', () => {
    const same = 'Reviewer requested changes 3 times. Automated fix attempts exhausted.';
    const html = render([item(20), item(21), item(22), item(1, same), item(2, same), item(3, same), item(4, same)]);
    const group = html.match(/<details[^>]*data-testid="needs-you-group"[\s\S]*?<\/details>/)?.[0] ?? '';
    expect(group).toContain('4 reviews');
    expect(group).toContain('Reviewer requested changes 3 times.');
    expect(group.match(/data-testid="needs-you-row"/g)).toHaveLength(4);
  });

  it('cards share one dialect: no swipe rail, no edge fade, no caps kicker', () => {
    const html = render([1, 2, 3].map(n => item(n)));
    expect(html).not.toMatch(/uppercase|tracking-\[|swipe|bg-gradient/i);
  });

  it('reviews held back while Buildd acts are named once in the quiet line', () => {
    const html = render([item(1)], 2);
    const also = html.match(/<p[^>]*data-testid="home-also"[\s\S]*?<\/p>/)?.[0] ?? '';
    expect(also).toContain('Also in progress: 2 reviews wait on a repair or checks.');
  });
});
