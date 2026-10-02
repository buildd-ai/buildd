import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import PrimaryAction, { primaryActionClass } from './PrimaryAction';

describe('PrimaryAction', () => {
  it('is a primary .btn at least 44px tall below md and 40px from md', () => {
    const cls = primaryActionClass({}).split(' ');
    expect(cls).toContain('btn');
    expect(cls).toContain('btn-primary');
    expect(cls).toContain('h-11');
    expect(cls).toContain('md:h-10');
  });

  it('renders a button (type=button by default) or a submit', () => {
    expect(renderToStaticMarkup(<PrimaryAction onClick={() => {}}>Approve</PrimaryAction>)).toMatch(/^<button type="button"/);
    expect(renderToStaticMarkup(<PrimaryAction type="submit">Save</PrimaryAction>)).toMatch(/^<button type="submit"/);
  });

  it('renders a link when given href', () => {
    const html = renderToStaticMarkup(<PrimaryAction href="/app/missions/new">New mission</PrimaryAction>);
    expect(html).toMatch(/^<a [^>]*href="\/app\/missions\/new"/);
  });

  it('pending shows the spinner, disables and marks busy', () => {
    const html = renderToStaticMarkup(<PrimaryAction pending onClick={() => {}}>Save</PrimaryAction>);
    expect(html).toContain('disabled=""');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('spinner-bar');
  });

  it('a disabled link is not a live link', () => {
    const html = renderToStaticMarkup(<PrimaryAction href="/x" disabled>Go</PrimaryAction>);
    expect(html).not.toContain('href=');
    expect(html).toContain('aria-disabled="true"');
  });

  it('danger tone and full width on mobile', () => {
    const cls = primaryActionClass({ tone: 'danger', fullWidthOnMobile: true }).split(' ');
    expect(cls).toContain('btn-danger');
    expect(cls).not.toContain('btn-primary');
    expect(cls).toContain('w-full');
    expect(cls).toContain('md:w-auto');
  });
});
