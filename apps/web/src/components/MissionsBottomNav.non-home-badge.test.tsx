import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// Regression test: badge should be consistent regardless of current page
// The badge should use home attention count (4) not escalation count (19)
mock.module('next/navigation', () => ({ usePathname: () => '/app/missions' }));
mock.module('./NeedsInputProvider', () => ({ useNeedsInput: () => ({ count: 0 }) }));
mock.module('./EscalationProvider', () => ({ useEscalation: () => ({ count: 19 }) }));
// Simulate that home attention count was published while on Home page, then persists
const homeAttentionCount = 4;
mock.module('@/lib/home-attention-store', () => ({ useHomeAttentionCount: () => homeAttentionCount }));
const { default: MissionsBottomNav } = await import('./MissionsBottomNav');

describe('Home badge consistency on non-Home pages', () => {
  it('shows consistent badge value that matches home headline', () => {
    const html = renderToStaticMarkup(<MissionsBottomNav />);
    // REGRESSION: Currently this fails - badge shows 19 instead of 4
    // After fix: badge should show home attention count (4), not escalation count (19)
    expect(html).toMatch(/nav-tab-badge[^>]*>4</);
    expect(html).not.toContain('>19<');
  });
});
