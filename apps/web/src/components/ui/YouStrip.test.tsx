import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import YouStrip, { type YouStripItem } from './YouStrip';

const item = (id: string, title = `Item ${id}`): YouStripItem => ({ id, title, reason: 'Review · 3 retries', href: `/app/tasks/${id}` });

describe('YouStrip', () => {
  it('AC-11: nothing waiting shows the green dot and the text, and no card', () => {
    const html = renderToStaticMarkup(<YouStrip waiting={[]} />);
    expect(html).toContain('data-testid="you-strip-dot"');
    expect(html).toContain('bg-status-success');
    expect(html).toContain('Nothing waiting on you');
    expect(html).not.toContain('you-strip-card');
    expect(html).not.toContain('status-error');
  });

  it('AC-11: one waiting shows its decision card, framed in the waiting-on-you colour', () => {
    const html = renderToStaticMarkup(<YouStrip waiting={[item('a', 'Stable attempt order')]} />);
    expect(html).toContain('data-item="a"');
    expect(html).toContain('Stable attempt order');
    expect(html).toContain('Review · 3 retries');
    expect(html).toContain('border-status-error');
    expect(html).toContain('href="/app/tasks/a"');
    expect(html).toContain('>Review<');
    expect(html).not.toContain('Nothing waiting on you');
    expect(html).not.toContain('you-strip-position');
  });

  it('shows the first of several with 1/N', () => {
    const html = renderToStaticMarkup(<YouStrip waiting={[item('a'), item('b'), item('c')]} />);
    expect(html).toContain('data-item="a"');
    expect(html).not.toContain('data-item="b"');
    expect(html).toContain(' · 1/3');
  });

  it('renders a page-supplied decision card in place of its own', () => {
    const html = renderToStaticMarkup(<YouStrip waiting={[item('a')]} decision={<article data-testid="full-decision">Full</article>} />);
    expect(html).toContain('full-decision');
    expect(html).not.toContain('you-strip-card');
  });
});
