/**
 * The context panel shows a section only when it has something in it: no
 * placeholder boxes, and an idle fleet is one quiet line, not a card.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import ChatContextPanel, { contextPanelModel, type ChatContextPanelProps } from './ChatContextPanel';

const base: ChatContextPanelProps = { audience: 'member', needsYou: [], missions: [], fleet: null };
const mission = { id: 'm1', title: 'Annual prep for three people and one very long mission title that keeps going', state: 'active', tone: 'live' as const };
const question = { id: 'q1', title: 'Round per line?', href: '/app/tasks/t1/respond' };

describe('contextPanelModel', () => {
  it('nothing to show: the panel is empty (the aside is dropped)', () => {
    expect(contextPanelModel(base).empty).toBe(true);
    expect(contextPanelModel({ ...base, fleet: { live: 0, capacity: 10 } }).empty).toBe(true);
  });

  it('an idle fleet is a quiet line; a busy one is the card', () => {
    expect(contextPanelModel({ ...base, missions: [mission], fleet: { live: 0, capacity: 10 } }).fleet).toBe('idle');
    expect(contextPanelModel({ ...base, fleet: { live: 2, capacity: 10 } }).fleet).toBe('busy');
    expect(contextPanelModel({ ...base, fleet: { live: 2, capacity: 10 } }).empty).toBe(false);
    expect(contextPanelModel({ ...base, missions: [mission] }).fleet).toBe('none');
  });

  it('sections appear only with content', () => {
    const m = contextPanelModel({ ...base, missions: [mission] });
    expect(m.needsYou).toBe(false);
    expect(m.missions).toBe(true);
    expect(contextPanelModel({ ...base, needsYou: [question] }).needsYou).toBe(true);
  });
});

describe('ChatContextPanel', () => {
  it('renders nothing when there is nothing to show', () => {
    expect(renderToStaticMarkup(<ChatContextPanel {...base} fleet={{ live: 0, capacity: 10 }} />)).toBe('');
  });

  it('no placeholder copy for an empty queue, and no "0 of N busy"', () => {
    const html = renderToStaticMarkup(<ChatContextPanel {...base} missions={[mission]} fleet={{ live: 0, capacity: 10 }} />);
    expect(html).not.toContain('Nothing is waiting');
    expect(html).not.toContain('0 of 10');
    expect(html).not.toContain('Needs you');
    expect(html).toContain('data-testid="chat-context-fleet-idle"');
  });

  it('long mission titles truncate inside the panel (min-w-0 through the grid)', () => {
    const html = renderToStaticMarkup(<ChatContextPanel {...base} missions={[mission]} />);
    // A grid track sizes to min-content unless its items can shrink; truncation
    // needs a shrinkable track and a shrinkable item.
    expect(html).toMatch(/<ul class="[^"]*grid-cols-\[minmax\(0,1fr\)\]/);
    expect(html).toMatch(/<li class="[^"]*min-w-0/);
  });

  it('a busy fleet is the card', () => {
    const html = renderToStaticMarkup(<ChatContextPanel {...base} audience="operator" fleet={{ live: 3, capacity: 10 }} />);
    expect(html).toContain('3 of 10 agents busy');
  });
});
