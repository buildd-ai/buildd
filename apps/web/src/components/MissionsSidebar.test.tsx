import { describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

let pathname = '/app/missions';
let search = '';
let homeCount: number | null = 6;
mock.module('next/navigation', () => ({
  usePathname: () => pathname,
  useRouter: () => ({ push: () => {}, replace: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(search),
}));
mock.module('next-auth/react', () => ({ signOut: () => {} }));
mock.module('@/lib/home-attention-store', () => ({ useHomeAttentionCount: () => homeCount }));

const { default: MissionsSidebar } = await import('./MissionsSidebar');

const TEAMS = [{ id: 't1', name: 'Cue', slug: 'cue' }, { id: 't2', name: 'Buildd', slug: 'buildd' }];
const WORKSPACES = [{ id: 'ws-1', name: 'web-app' }, { id: 'ws-2', name: 'api' }];
const render = () => renderToStaticMarkup(<MissionsSidebar userInitial="M" teams={TEAMS} currentTeamId="t1" workspaces={WORKSPACES} />);
const link = (html: string, href: string) => html.match(new RegExp(`<a[^>]*href="${href}"[\\s\\S]*?</a>`))?.[0] ?? '';
const text = (html: string) => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');

describe('MissionsSidebar (labelled side rail)', () => {
  it('five labelled destinations, labels always visible (not hover tooltips)', () => {
    const html = render();
    const items = [...html.matchAll(/data-testid="rail-item-label"[^>]*>([^<]+)</g)].map(m => m[1]);
    expect(items).toEqual(['Home', 'Missions', 'Activity', 'Health', 'Chat']);
    expect(html).not.toMatch(/opacity-0 group-hover:opacity-100/);
    for (const gone of ['/app/releases', '/app/initiatives', '/app/team"']) expect(html).not.toContain(`href="${gone}`);
  });

  it('marks the active item; Missions owns Releases and Initiatives', () => {
    pathname = '/app/releases';
    try {
      const html = render();
      expect(link(html, '/app/missions')).toContain('aria-current="page"');
      expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    } finally {
      pathname = '/app/missions';
    }
  });

  it('the Home badge is the needs-you count Home publishes, never the escalation inbox', () => {
    const html = render();
    expect(link(html, '/app/home')).toMatch(/data-testid="rail-badge"[^>]*>6</);
    expect(html).not.toContain('bg-status-error');
    expect(link(html, '/app/home')).not.toContain('bg-status-error');
  });

  it('no badge before Home has published a count', () => {
    homeCount = null;
    try {
      expect(render()).not.toContain('rail-badge');
    } finally {
      homeCount = 6;
    }
  });

  it('one scope switcher at the top names the team and, on filtered pages, the workspace', () => {
    search = 'workspace=ws-2';
    try {
      const html = render();
      const switcher = html.match(/<button[^>]*data-testid="scope-switcher"[\s\S]*?<\/button>/)?.[0] ?? '';
      expect(text(switcher)).toContain('Cue');
      expect(text(switcher)).toContain('api');
      expect(html.indexOf('data-testid="scope-switcher"')).toBeLessThan(html.indexOf('href="/app/home"'));
    } finally {
      search = '';
    }
  });

  it('off a filtered page, the switcher names only the team', () => {
    pathname = '/app/chat';
    try {
      const switcher = render().match(/<button[^>]*data-testid="scope-switcher"[\s\S]*?<\/button>/)?.[0] ?? '';
      expect(text(switcher)).toContain('Cue');
      expect(text(switcher)).not.toMatch(/All workspaces|web-app|api/);
    } finally {
      pathname = '/app/missions';
    }
  });

  it('no theme toggle, no settings gear and no tiny caps labels: those live in the avatar menu', () => {
    const html = render();
    expect(html).not.toMatch(/aria-label="Switch theme/);
    expect(html).not.toContain('aria-label="Settings"');
    expect(html).not.toMatch(/text-\[(7|8|9)px\]|\buppercase\b/);
    expect(html).toContain('aria-label="Account menu"');
  });
});
