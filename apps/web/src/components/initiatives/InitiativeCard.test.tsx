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
import { InitiativeRow, segmentStripState } from './InitiativeCard';

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
  return renderToStaticMarkup(<InitiativeRow card={card} />);
}

const count = (html: string, needle: string) => html.split(needle).length - 1;

describe('InitiativeRow', () => {
  it('draws one small strip cell per mission and the same n/N as the strip', () => {
    const html = render([done('a'), done('b'), mission('c')]);
    expect(count(html, 'data-testid="task-strip"')).toBe(1);
    expect(html).toContain('data-size="sm"');
    expect(count(html, 'class="state-cell')).toBe(3);
    expect(count(html, 'data-state="landed"')).toBe(2);
    expect(html).not.toContain('initiative-bar');
    expect(html).toContain('<b class="font-semibold text-text-primary">2</b>/3 missions done');
  });

  it('is an L1 row: no card, no state stripe', () => {
    const html = render([mission('a')]);
    expect(html).toContain('data-testid="initiative-row"');
    expect(html).not.toMatch(/class="card\b/);
    expect(html).not.toContain('border-l-[6px]');
    expect(html).toContain('border-t');
  });

  it('shows the status a person set as a sentence-case pill, the owner and the target date', () => {
    const html = render([mission('a')]);
    expect(html).toContain('data-status="active"');
    expect(html).toContain('data-tone="run"');
    expect(html).toContain('>Active<');
    expect(html).not.toContain('uppercase');
    expect(html).toContain('Ines');
    expect(html).toContain('Due Oct 14');
  });

  it('a finished initiative offers Mark completed as a text action, and no percentage or verdict word', () => {
    const html = render([done('a'), done('b')]);
    expect(html).toContain('All 2 missions done');
    expect(html).toContain('Mark completed');
    expect(html).not.toMatch(/\d+%/);
    expect(html).not.toMatch(/losing|stuck|dormant|unverified|ready to close/i);
    expect(html).not.toContain('bg-primary');
    expect(html).not.toContain('btn-ink');
  });

  it('links the mission that needs you, and makes Answer the one ink button', () => {
    const html = render([mission('q', { statusLabel: 'Needs you', tone: 'warning', question: { label: 'urls', href: '/app/missions/q?task=t', prompt: 'Which?' } })]);
    expect(html).toContain('1 mission needs you');
    expect(html).toContain('href="/app/missions/q?task=t"');
    const answer = html.match(/<a[^>]*data-kind="answer"[^>]*>/)?.[0] ?? '';
    expect(answer).toContain('btn-ink');
    expect(html).not.toContain('bg-primary');
  });

  it('does not list the missions in the row (the strip enumerates them)', () => {
    const html = render(['a', 'b', 'c', 'd', 'e', 'f'].map((id) => mission(id)));
    expect(count(html, 'data-testid="initiative-mission"')).toBe(0);
    expect(count(html, 'class="state-cell')).toBe(6);
  });

  it('has no Open button: the title is the link', () => {
    const html = render([mission('a')]);
    expect(html).not.toContain('data-kind="open"');
    expect(html).toContain('href="/app/initiatives/i1"');
  });
});

describe('segmentStripState', () => {
  it('maps each mission segment to a strip state', () => {
    expect(segmentStripState('done')).toBe('landed');
    expect(segmentStripState('needs_you')).toBe('needs_you');
    expect(segmentStripState('running')).toBe('running');
    expect(segmentStripState('waiting')).toBe('ready');
    expect(segmentStripState('held')).toBe('waiting');
  });
});
