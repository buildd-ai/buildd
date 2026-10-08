import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
mock.module('next/navigation', () => ({ usePathname: () => '/app/home' }));
mock.module('./NeedsInputProvider', () => ({ useNeedsInput: () => ({ count: 0 }) }));
mock.module('./EscalationProvider', () => ({ useEscalation: () => ({ count: 99 }) }));
let inboxCount: number | null = 4;
mock.module('@/lib/home-attention-store', () => ({ useHomeAttentionCount: () => inboxCount }));
const { default: MissionsBottomNav } = await import('./MissionsBottomNav');
describe('Home inbox nav badge', () => {
  it('uses the inbox count and neutral active label', () => {
    const html = renderToStaticMarkup(<MissionsBottomNav />);
    expect(html).toMatch(/nav-tab-badge[^>]*>4</);
    expect(html).not.toContain('>99<');
    expect(html).not.toContain('nav-active-bar');
    expect(html).toContain('>home<');
    expect(html).toContain('bg-accent');
  });

  it('does not substitute an unrelated escalation count before the inbox mounts', () => {
    inboxCount = null;
    expect(renderToStaticMarkup(<MissionsBottomNav />)).not.toContain('nav-tab-badge');
  });
});
