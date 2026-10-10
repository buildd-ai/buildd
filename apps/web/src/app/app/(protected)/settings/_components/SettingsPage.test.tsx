/**
 * The header holds a desktop-only h1 and an optional description. Without a
 * description it is empty on a phone, but as a child of `space-y-8` it still
 * took a 32px gap at the top of every mobile settings page.
 */
import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import SettingsPage from './SettingsPage';

function headerClass(html: string): string {
  const m = html.match(/<header(?:\s+class="([^"]*)")?/);
  if (!m) throw new Error('no header rendered');
  return m[1] ?? '';
}

describe('SettingsPage', () => {
  it('hides the header below md when there is no description', () => {
    const html = renderToStaticMarkup(<SettingsPage title="Billing"><p>x</p></SettingsPage>);
    const cls = headerClass(html).split(/\s+/);
    expect(cls).toContain('hidden');
    expect(cls).toContain('md:block');
  });

  it('keeps the header visible on a phone when there is a description', () => {
    const html = renderToStaticMarkup(
      <SettingsPage title="Billing" description="What you pay."><p>x</p></SettingsPage>,
    );
    expect(headerClass(html).split(/\s+/)).not.toContain('hidden');
    expect(html).toContain('What you pay.');
  });

  it('titleOnMobile shows the h1 on a phone, even with no description', () => {
    const html = renderToStaticMarkup(<SettingsPage title="web-app" titleOnMobile><p>x</p></SettingsPage>);
    expect(headerClass(html).split(/\s+/)).not.toContain('hidden');
    const h1 = html.match(/<h1 class="([^"]*)">web-app<\/h1>/);
    expect(h1).not.toBeNull();
    expect(h1![1].split(/\s+/)).not.toContain('hidden');
  });

  it('keeps the h1 desktop-only by default', () => {
    const html = renderToStaticMarkup(<SettingsPage title="Billing" description="d"><p>x</p></SettingsPage>);
    expect(html).toMatch(/<h1 class="hidden md:block[^"]*">Billing<\/h1>/);
  });
});
