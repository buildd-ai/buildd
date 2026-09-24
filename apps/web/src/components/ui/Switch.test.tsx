import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import Switch from './Switch';

describe('Switch', () => {
  it('renders a named button with role=switch and aria-checked', () => {
    const html = renderToStaticMarkup(<Switch checked onChange={() => {}} label="Quiet hours" />);
    expect(html).toContain('type="button"');
    expect(html).toContain('role="switch"');
    expect(html).toContain('aria-checked="true"');
    expect(html).toContain('aria-label="Quiet hours"');
  });

  it('reflects unchecked state', () => {
    const html = renderToStaticMarkup(<Switch checked={false} onChange={() => {}} label="x" />);
    expect(html).toContain('aria-checked="false"');
  });

  it('can take its name from a visible element via labelledBy', () => {
    const html = renderToStaticMarkup(<Switch checked={false} onChange={() => {}} labelledBy="title-id" />);
    expect(html).toContain('aria-labelledby="title-id"');
    expect(html).not.toContain('aria-label=');
  });

  it('keeps a visible focus ring and does not fill with a status color', () => {
    const html = renderToStaticMarkup(<Switch checked onChange={() => {}} label="x" />);
    expect(html).toContain('focus-visible:');
    expect(html).not.toMatch(/focus:outline-none/);
    expect(html).not.toMatch(/bg-status-/);
  });

  it('renders disabled', () => {
    const html = renderToStaticMarkup(<Switch checked onChange={() => {}} label="x" disabled />);
    expect(html).toContain('disabled=""');
  });
});
