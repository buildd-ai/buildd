import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({ usePathname: () => '/app/home' }));
mock.module('./NeedsInputProvider', () => ({ useNeedsInput: () => ({ count: 3 }) }));
mock.module('./EscalationProvider', () => ({ useEscalation: () => ({ count: 0 }) }));

const { default: MissionsBottomNav } = await import('./MissionsBottomNav');

/** Inner HTML of the first <span> whose class contains `cls` (depth-matched). */
function spanContents(html: string, cls: string): string {
  const open = html.search(new RegExp(`<span class="[^"]*${cls}[^"]*">`));
  if (open < 0) return '';
  const start = html.indexOf('>', open) + 1;
  let depth = 1;
  const re = /<span\b|<\/span>/g;
  re.lastIndex = start;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    depth += m[0] === '</span>' ? -1 : 1;
    if (depth === 0) return html.slice(start, m.index);
  }
  return html.slice(start);
}

describe('MissionsBottomNav badges', () => {
  it('an inactive tab dims its icon but not its badge', () => {
    const html = renderToStaticMarkup(<MissionsBottomNav />);
    const activity = html.match(/<a[^>]*href="\/app\/tasks"[\s\S]*?<\/a>/)?.[0] ?? '';
    expect(activity).toContain('>3<');
    // The badge must not be a descendant of the opacity-35 wrapper.
    expect(activity).toContain('opacity-35');
    expect(spanContents(activity, 'opacity-35')).not.toContain('>3<');
  });
});
