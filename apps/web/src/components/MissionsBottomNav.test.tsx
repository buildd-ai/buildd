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

  it('labels keep a readable gap between neighbours at 320px and 390px', () => {
    const link = html.match(/<a\b[^>]*>/)?.[0] ?? '';
    const cls = (prefix: string) => link.match(new RegExp(`(?:^|[\\s"])${prefix}text-\\[(\\d+)px\\]`))?.[1];
    const tracking = (prefix: string) => link.match(new RegExp(`(?:^|[\\s"])${prefix}tracking-\\[\\.(\\d+)em\\]`))?.[1];
    const MONO_ADVANCE = 0.6;
    const longest = 8; // "MISSIONS" / "ACTIVITY"
    const gap = (viewport: number, size: number, trackEm: number) =>
      viewport / 5 - longest * size * (MONO_ADVANCE + trackEm);
    const base = Number(cls('')), baseTrack = Number(`0.${tracking('') ?? '0'}`);
    const wide = Number(cls('min-\\[390px\\]:') ?? base);
    const wideTrack = Number(`0.${tracking('min-\\[390px\\]:') ?? tracking('') ?? '0'}`);
    expect(gap(320, base, baseTrack)).toBeGreaterThanOrEqual(8);
    expect(gap(390, wide, wideTrack)).toBeGreaterThanOrEqual(8);
  });

  it('an alert count still shows on its tab', () => {
    expect(tab('/app/tasks')).toMatch(/data-testid="nav-tab-badge"[^>]*>3</);
  });
});
