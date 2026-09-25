import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { GroupSection } from './GroupSection';

const bandClass = (html: string) => html.match(/^<div class="([^"]*)"/)?.[1] ?? '';

// The Activity list scrolls inside <main>, under the fixed mobile header
// (MobilePageHeader, md:hidden). A band stuck at top-0 slid up behind — and,
// being later in the DOM at the same z-index, painted over — that header.
describe('GroupSection sticky offset', () => {
  it('clears the fixed mobile header when mounted below it, and sticks at 0 from md up', () => {
    const cls = bandClass(renderToStaticMarkup(<GroupSection title="Today" taskCount={3} belowMobileHeader />));
    expect(cls).toContain('sticky');
    expect(cls).toContain('top-[var(--mobile-header-h,53px)]');
    expect(cls).toContain('md:top-0');
    expect(cls.split(/\s+/)).not.toContain('top-0');
  });

  it('sticks at top-0 where no mobile header is rendered (mission detail timeline)', () => {
    const cls = bandClass(renderToStaticMarkup(<GroupSection title="Today" taskCount={3} />));
    expect(cls.split(/\s+/)).toContain('top-0');
    expect(cls).not.toContain('mobile-header-h');
  });
});
