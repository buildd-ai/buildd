import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let pathname = '/app/chat';
let homeCount: number | null = 4;
mock.module('next/navigation', () => ({ usePathname: () => pathname }));
mock.module('./NeedsInputProvider', () => ({ useNeedsInput: () => ({ count: 3 }) }));
mock.module('@/lib/home-attention-store', () => ({ useHomeAttentionCount: () => homeCount }));

const { default: MissionsBottomNav } = await import('./MissionsBottomNav');

const render = () => renderToStaticMarkup(<MissionsBottomNav />);
const tab = (html: string, href: string) => html.match(new RegExp(`<a[^>]*href="${href}"[\\s\\S]*?</a>`))?.[0] ?? '';

describe('MissionsBottomNav', () => {
  it('five sentence-case labels in nav order, no icons, no caps', () => {
    const html = render();
    expect(html).not.toContain('<svg');
    expect(html).not.toMatch(/\buppercase\b|tracking-\[/);
    const labels = [...html.matchAll(/data-testid="nav-tab-label"[^>]*>([^<]+)</g)].map(m => m[1]);
    expect(labels).toEqual(['Home', 'Missions', 'Activity', 'Health', 'Chat']);
  });

  it('marks only the active tab: ink text and a bar on its top edge', () => {
    const html = render();
    expect(tab(html, '/app/chat')).toContain('aria-current="page"');
    expect(tab(html, '/app/chat')).toMatch(/nav-active-bar"[^>]*top-0/);
    expect(tab(html, '/app/chat')).toContain('text-text-primary');
    expect(html.match(/nav-active-bar/g)).toHaveLength(1);
    expect(tab(html, '/app/home')).not.toContain('aria-current');
  });

  it('one style on every page: Home renders the bar the same way as anywhere else', () => {
    const elsewhere = render().replace(/aria-current="page"|nav-active-bar/g, '');
    pathname = '/app/home';
    try {
      const html = render();
      expect(tab(html, '/app/home')).toContain('data-testid="nav-active-bar"');
      expect(html.match(/<nav[^>]*>/)?.[0]).toBe(elsewhere.match(/<nav[^>]*>/)?.[0]);
      expect(html).toContain('>Home<');
    } finally {
      pathname = '/app/chat';
    }
  });

  it('every tab is at least a 44px touch target', () => {
    const links = render().match(/<a\b[^>]*>/g) ?? [];
    expect(links.length).toBe(5);
    for (const a of links) expect(a).toMatch(/min-h-11/);
  });

  it('one badge: Home carries the needs-you count; Activity carries none', () => {
    const html = render();
    expect(tab(html, '/app/home')).toMatch(/data-testid="nav-tab-badge"[^>]*>4</);
    expect(tab(html, '/app/tasks')).not.toContain('nav-tab-badge');
    expect(html.match(/nav-tab-badge/g)).toHaveLength(1);
    expect(html).not.toContain('>19<');
  });

  it('no badge before Home has published a count; never a substitute count', () => {
    homeCount = null;
    try {
      expect(render()).not.toContain('nav-tab-badge');
    } finally {
      homeCount = 4;
    }
  });
});
