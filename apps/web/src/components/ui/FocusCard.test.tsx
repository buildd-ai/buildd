import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import FocusCard from './FocusCard';
import { reasonLine } from './task-strip';

describe('FocusCard', () => {
  const base = { meta: '04 · level 3 of 5 · builder', title: 'Missions portfolio list', state: 'running' as const };

  it('renders the lifecycle and the reason line', () => {
    const html = renderToStaticMarkup(<FocusCard {...base} next="Opens a PR when the build finishes" reason={reasonLine('downstream', ['06'])} />);
    expect(html).toContain('data-testid="lifecycle"');
    expect(html).toContain('>Unblocks</dt>');
    expect(html).toContain('06.');
  });

  it('a focused card carries the 1.5px ink frame from md, a quiet hairline on a phone', () => {
    const html = renderToStaticMarkup(<FocusCard {...base} />);
    expect(html).toContain('md:border-[1.5px] md:border-text-primary');
    expect(html).toContain('border border-border-strong');
    expect(html).not.toMatch(/ border-\[1\.5px\]/);
    expect(renderToStaticMarkup(<FocusCard {...base} focused={false} />)).not.toContain('border-[1.5px]');
  });

  it('has no Time row without an estimate', () => {
    expect(renderToStaticMarkup(<FocusCard {...base} />)).not.toContain('Time');
  });

  it('Time row: so far against the plan', () => {
    const html = renderToStaticMarkup(<FocusCard {...base} estimate={{ p50: 60, p80: 100, actual: 18 }} />);
    expect(html).toContain('18m so far · planned 60–100m');
  });

  it('Time row: over p80 is marked in the live tone', () => {
    const html = renderToStaticMarkup(<FocusCard {...base} estimate={{ p50: 45, p80: 80, actual: 95 }} />);
    expect(html).toContain('data-over="true"');
    expect(html).toContain('▲');
  });

  it('Time row: landed reads the total, not "so far"', () => {
    const html = renderToStaticMarkup(<FocusCard {...base} state="landed" estimate={{ p50: 20, p80: 35, actual: 22 }} />);
    expect(html).toContain('22m · planned 20–35m');
  });

  it('a held task names its state in the meta line', () => {
    expect(renderToStaticMarkup(<FocusCard {...base} state="queued" />)).toContain('data-state="queued"');
  });
});
