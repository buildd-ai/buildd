/**
 * The settings sub-nav column must run the full height of the page. Its fill
 * and rule used to sit on the sticky, viewport-tall <nav>, so on a page taller
 * than the screen the column stopped partway down.
 */
import { describe, expect, it, mock } from 'bun:test';

mock.module('next/navigation', () => ({
  usePathname: () => '/app/settings/models',
}));

const { renderToStaticMarkup } = await import('react-dom/server');
const { default: SettingsSubNav } = await import('./SettingsSubNav');
const { default: SettingsLayout } = await import('../layout');

describe('SettingsSubNav', () => {
  it('draws the column fill on a stretching wrapper, not on the sticky nav', () => {
    const html = renderToStaticMarkup(<SettingsSubNav />);
    const wrapper = html.match(/^<div[^>]*class="([^"]*)"/)![1];
    expect(wrapper).toContain('bg-surface-2');
    expect(wrapper).toContain('border-r');
    const nav = html.match(/<nav[^>]*class="([^"]*)"/)![1];
    expect(nav).toContain('sticky');
    expect(nav).not.toContain('bg-surface-2');
  });

  it('marks the active item with ink text on the quiet tint, never orange or a stripe', () => {
    const html = renderToStaticMarkup(<SettingsSubNav />);
    const active = html.match(/<a[^>]*data-active="true"[^>]*>/)![0];
    const cls = active.match(/class="([^"]*)"/)![1];
    expect(cls).toContain('text-text-primary');
    expect(cls).toContain('bg-[var(--q-tint)]');
    expect(cls).not.toMatch(/accent/);
    expect(cls).not.toContain('border-l');
  });

  it('the layout lets the column stretch to the content height', () => {
    const html = renderToStaticMarkup(<SettingsLayout><p>x</p></SettingsLayout>);
    const outer = html.match(/^<div[^>]*class="([^"]*)"/)![1];
    expect(outer).toContain('md:flex');
    expect(outer).not.toContain('items-start');
  });
});
