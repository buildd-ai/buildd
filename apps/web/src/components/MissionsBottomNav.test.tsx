import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({ usePathname: () => '/app/chat' }));
mock.module('./NeedsInputProvider', () => ({ useNeedsInput: () => ({ count: 3 }) }));
mock.module('./EscalationProvider', () => ({ useEscalation: () => ({ count: 0 }) }));

const { default: MissionsBottomNav } = await import('./MissionsBottomNav');

const html = renderToStaticMarkup(<MissionsBottomNav />);
const tab = (href: string) => html.match(new RegExp(`<a[^>]*href="${href}"[\\s\\S]*?</a>`))?.[0] ?? '';

describe('MissionsBottomNav (v3 phone nav)', () => {
  it('mono caps labels in order, no icons', () => {
    expect(html).not.toContain('<svg');
    expect(html).toMatch(/<nav[^>]*font-mono/);
    expect(html).toMatch(/<nav[^>]*uppercase/);
    const labels = [...html.matchAll(/data-testid="nav-tab-label"[^>]*>([^<]+)</g)].map(m => m[1]);
    expect(labels).toEqual(['Home', 'Chat', 'Missions', 'Activity', 'Health']);
  });

  it('marks only the active tab, with a bar on its top edge', () => {
    expect(tab('/app/chat')).toContain('aria-current="page"');
    expect(tab('/app/chat')).toContain('data-testid="nav-active-bar"');
    expect(tab('/app/chat')).toMatch(/nav-active-bar"[^>]*top-0/);
    expect(html.match(/nav-active-bar/g)).toHaveLength(1);
    expect(tab('/app/home')).not.toContain('aria-current');
  });

  it('every tab is at least a 44px touch target', () => {
    const links = html.match(/<a\b[^>]*>/g) ?? [];
    expect(links.length).toBe(5);
    for (const a of links) expect(a).toMatch(/min-h-11/);
  });

  it('an alert count still shows on its tab', () => {
    expect(tab('/app/tasks')).toMatch(/data-testid="nav-tab-badge"[^>]*>3</);
  });
});
