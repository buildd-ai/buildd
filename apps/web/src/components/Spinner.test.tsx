import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Spinner from './Spinner';

describe('Spinner', () => {
  it('renders five bars with no border-radius classes — the brutalist theme zeroes rounded-full', () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).not.toContain('rounded');
    expect(html).not.toContain('animate-spin');
    const barCount = (html.match(/spinner-bar/g) || []).length;
    expect(barCount).toBe(5);
  });

  it('staggers each bar with its own 0.2s multiple animation-delay', () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).toContain('animation-delay:0s');
    expect(html).toContain('animation-delay:0.2s');
    expect(html).toContain('animation-delay:0.4s');
  });

  it('uses currentColor via bg-current-less spinner-bar class so callers tint with text-* classes', () => {
    const html = renderToStaticMarkup(<Spinner className="text-status-running" />);
    expect(html).toContain('text-status-running');
  });

  it('exposes role=status and a caller-supplied aria-label', () => {
    const html = renderToStaticMarkup(<Spinner aria-label="Merging" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Merging"');
  });

  it('defaults to an aria-label when the caller does not supply one', () => {
    const html = renderToStaticMarkup(<Spinner />);
    expect(html).toContain('aria-label="Loading"');
  });

  it('supports xs/sm/md sizes with distinct bar dimensions', () => {
    const xs = renderToStaticMarkup(<Spinner size="xs" />);
    const sm = renderToStaticMarkup(<Spinner size="sm" />);
    const md = renderToStaticMarkup(<Spinner size="md" />);
    expect(xs).not.toBe(sm);
    expect(sm).not.toBe(md);
    // Default size prop is 'md'.
    expect(renderToStaticMarkup(<Spinner />)).toBe(md);
  });
});
