/**
 * The initiative card render. Fixtures are illustrative.
 */
import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }),
  usePathname: () => '/app/initiatives',
  useSearchParams: () => new URLSearchParams(''),
}));

import { buildInitiativeCard, type InitiativeMissionInput } from '@/lib/initiative-view';
import { InitiativeCard } from './InitiativeCard';

const NOW = Date.parse('2026-09-26T12:00:00Z');

function mission(id: string, over: Partial<InitiativeMissionInput> = {}): InitiativeMissionInput {
  return {
    id, title: `Mission ${id}`, status: 'active', href: `/app/missions/${id}`, kind: 'active',
    statusLabel: 'Running', tone: 'accent', done: 1, total: 4, failed: 0, question: null, ask: null, ...over,
  };
}
const done = (id: string) => mission(id, { status: 'completed', kind: 'done', statusLabel: 'Done', tone: 'success', done: 4, total: 4 });

function render(missions: InitiativeMissionInput[], over: Record<string, unknown> = {}) {
  const card = buildInitiativeCard(
    { id: 'i1', title: 'Public API', description: null, status: 'active', targetDate: '2026-10-14', owner: { name: 'Ines' }, missions, ...over } as any,
    { now: NOW },
  );
  return renderToStaticMarkup(<InitiativeCard card={card} />);
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('InitiativeCard', () => {
  it('draws one bar segment per mission and the same n/N as the bar', () => {
    const html = render([done('a'), done('b'), mission('c')]);
    expect(count(html, 'data-testid="initiative-bar-segment"')).toBe(3);
    expect(count(html, 'data-state="done"')).toBe(2);
    expect(html).toContain('<b class="font-semibold text-text-primary">2</b>/3 missions done');
  });

  it('shows the status a person set, the owner and the target date', () => {
    const html = render([mission('a')]);
    expect(html).toContain('data-status="active"');
    expect(html).toContain('>Active<');
    expect(html).toContain('Ines');
    expect(html).toContain('Due Oct 14');
  });

  it('a finished initiative shows Mark completed, and no percentage or verdict word', () => {
    const html = render([done('a'), done('b')]);
    expect(html).toContain('All 2 missions done');
    expect(html).toContain('Mark completed');
    expect(html).not.toMatch(/\d+%/);
    expect(html).not.toMatch(/losing|stuck|dormant|unverified|ready to close/i);
  });

  it('links the mission that needs you, and makes Answer the action', () => {
    const html = render([mission('q', { statusLabel: 'Needs you', tone: 'warning', question: { label: 'urls', href: '/app/missions/q?task=t', prompt: 'Which?' } })]);
    expect(html).toContain('1 mission needs you');
    expect(html).toContain('href="/app/missions/q?task=t"');
    expect(html).toContain('data-kind="answer"');
  });

  it('caps the mission list at four with a link to the rest', () => {
    const html = render(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => mission(id)));
    expect(count(html, 'data-testid="initiative-mission"')).toBe(4);
    expect(html).toContain('+ 2 more missions');
  });
});
