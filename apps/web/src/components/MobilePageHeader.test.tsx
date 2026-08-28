import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

mock.module('next/navigation', () => ({
  usePathname: () => '/app/connections',
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

const MobilePageHeader = (await import('./MobilePageHeader')).default;

const TEAMS = [
  { id: 't1', name: 'Cue', slug: 'cue' },
  { id: 't2', name: 'Buildd', slug: 'buildd' },
];

function render(props: Parameters<typeof MobilePageHeader>[0] = {}) {
  return renderToStaticMarkup(<MobilePageHeader {...props} />);
}

describe('MobilePageHeader', () => {
  it('shows the team name exactly once — as the switcher, not as static title text', () => {
    const html = render({ teams: TEAMS, currentTeamId: 't1', userInitial: 'M' });
    // Count rendered text only — attribute values (e.g. the switcher's aria-label)
    // are not visible duplicates.
    const text = html.replace(/<[^>]*>/g, '');
    expect(text.match(/Cue/g)?.length).toBe(1);
    // And that single occurrence must be the tappable control.
    const button = html.match(/<button[\s\S]*?<\/button>/)?.[0] ?? '';
    expect(button).toContain('Cue');
  });

  it('places the team switcher in the title cluster, left of the account avatar', () => {
    const html = render({ teams: TEAMS, currentTeamId: 't1', userInitial: 'M' });
    expect(html.indexOf('Cue')).toBeLessThan(html.lastIndexOf('M'));
    expect(html).toContain('Connections');
  });

  it('keeps the title truncatable so the row cannot overflow at 320pt', () => {
    const html = render({ teams: TEAMS, currentTeamId: 't1' });
    expect(html).toContain('truncate');
    expect(html).toContain('min-w-0');
  });

  it('renders the title alone when the user has no teams', () => {
    const html = render({ userInitial: 'M' });
    expect(html).toContain('Connections');
    expect(html).not.toContain('·');
  });
});
