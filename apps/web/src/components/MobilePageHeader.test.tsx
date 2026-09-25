import { describe, it, expect, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let pathname = '/app/connections';
mock.module('next/navigation', () => ({
  usePathname: () => pathname,
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


  it('keeps WorkspaceFilter label hidden on mobile to prevent breadcrumb crowding at 320pt', () => {
    pathname = '/app/missions'; // a page that reads ?workspace=
    const html = render({
      teams: TEAMS,
      currentTeamId: 't1',
      userInitial: 'M',
      workspaces: [
        { id: 'ws-1', name: 'Buildd Core' },
      ],
    });
    // The label should only appear on md+ screens (hidden md:inline means hidden below 768px)
    expect(html).toContain('hidden md:inline');
    // Verify that "All workspaces" text (the default when no workspace selected) has the hidden class
    expect(html).toContain('All workspaces</span>');
    // Ensure the icon and chevron structure is present for mobile
    expect(html).toContain('md:hidden');
    pathname = '/app/connections';
  });

  it('omits the WorkspaceFilter on pages that ignore ?workspace=', () => {
    const html = render({ teams: TEAMS, currentTeamId: 't1', workspaces: [{ id: 'ws-1', name: 'Example' }] });
    expect(html).not.toContain('Filter by workspace');
    pathname = '/app/missions';
    try {
      expect(render({ teams: TEAMS, currentTeamId: 't1', workspaces: [{ id: 'ws-1', name: 'Example' }] })).toContain(
        'Filter by workspace',
      );
    } finally {
      pathname = '/app/connections';
    }
  });

  it('maintains layout hierarchy at 320pt: left cluster before right cluster', () => {
    const html = render({
      teams: TEAMS,
      currentTeamId: 't1',
      userInitial: 'M',
      workspaces: [{ id: 'ws-1', name: 'Example Workspace' }],
    });
    const leftCluster = html.indexOf('flex-1 min-w-0');
    const rightCluster = html.indexOf('gap-2 shrink-0');
    // Left cluster (with flex-1) should come before right cluster (with shrink-0)
    expect(leftCluster).toBeLessThan(rightCluster);
  });

describe('MobilePageHeader banner stack', () => {
  const banner = <div data-testid="needs-input-banner-stub">A task needs your input</div>;

  it('renders banners inside the same fixed stack as the header, below the header row', () => {
    const html = render({ teams: TEAMS, currentTeamId: 't1', banners: banner });
    const stack = html.match(/<div[^>]*data-testid="mobile-top-stack"[^>]*>/)?.[0] ?? '';
    expect(stack).toContain('max-md:fixed');
    expect(stack).toContain('max-md:top-0');
    // The header row itself is no longer independently fixed (it would cover the banner).
    const headerRow = html.match(/<div[^>]*data-testid="mobile-page-header"[^>]*>/)?.[0] ?? '';
    expect(headerRow).not.toMatch(/(^|[\s"])fixed /);
    expect(html.indexOf('mobile-page-header')).toBeLessThan(html.indexOf('needs-input-banner-stub'));
    expect(html.indexOf('mobile-top-stack')).toBeLessThan(html.indexOf('needs-input-banner-stub'));
  });

  it('reserves in-flow space for the banners on mobile so they do not cover page content', () => {
    const html = render({ teams: TEAMS, currentTeamId: 't1', banners: banner });
    expect(html).toContain('data-testid="mobile-banner-spacer"');
  });

  it('still renders banners, in flow, on detail pages that have no mobile header', () => {
    pathname = '/app/missions/some-mission';
    try {
      const html = render({ teams: TEAMS, currentTeamId: 't1', banners: banner });
      expect(html).toContain('needs-input-banner-stub');
      expect(html).not.toContain('mobile-page-header');
      expect(html).not.toContain('fixed');
    } finally {
      pathname = '/app/connections';
    }
  });
});
