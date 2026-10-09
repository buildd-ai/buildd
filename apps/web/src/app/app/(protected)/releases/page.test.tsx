import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// Synthetic history exceeds the list fetch cap.
const history = Array.from({ length: 101 }, (_, i) => ({
  id: `release-${i}`,
  workspaceId: 'demo-workspace',
  archetype: 'gated',
  state: 'healthy',
  failureReason: null as string | null,
  version: `v1.2.${i}`,
  releaseTasks: [],
}));
let listedReleases = history;
let totalReleases = history.length;
let successors: { id: string; version: string | null }[] = [];
const findMany = mock(async ({ limit }: { limit: number }) => listedReleases.slice(0, limit));
beforeEach(() => { listedReleases = history; totalReleases = history.length; successors = []; });
mock.module('@buildd/core/db', () => ({
  db: {
    select: (columns: { version?: unknown; total?: unknown }) => ({
      from: () => ({
        where: async () => columns.total
          ? [{ total: totalReleases }]
          : columns.version ? successors : [{
            id: 'demo-workspace', name: 'Demo',
            releaseConfig: { enabled: true }, gitConfig: null,
          }],
      }),
    }),
    query: { releases: { findMany } },
  },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'demo-user' }) }));
mock.module('@/lib/team-access', () => ({
  getUserTeamIds: async () => ['demo-team'],
  resolveActiveTeamId: async () => 'demo-team',
}));
mock.module('next/headers', () => ({ cookies: async () => ({ get: () => undefined }) }));

const { default: ReleasesPage } = await import('./page');

const renderPage = async () => renderToStaticMarkup(await ReleasesPage({ searchParams: Promise.resolve({}) }));
const count = (html: string, needle: string | RegExp) =>
  typeof needle === 'string' ? html.split(needle).length - 1 : (html.match(needle) ?? []).length;

describe('ReleasesPage header', () => {
  it('counts the real total, not the fetch limit, and says the list is truncated', async () => {
    totalReleases = 250;
    const html = await renderPage();
    expect(findMany).toHaveBeenCalled();
    expect(html).toContain('Latest 100 of 250 releases');
    expect(html).not.toContain('>100 releases');
  });

  it('shows a plain count when the whole history fits', async () => {
    listedReleases = history.slice(0, 3);
    totalReleases = 3;
    expect(await renderPage()).toContain('3 releases');
  });

  it('hides the h1 below md, where the shell header already names the page', async () => {
    const h1 = (await renderPage()).match(/<h1[^>]*>/)?.[0] ?? '';
    expect(h1).toContain('sr-only');
    expect(h1).toContain('md:not-sr-only');
  });
});

describe('ReleasesPage list', () => {
  it('renders history as L1 rows: no cards, no archetype badge, no Run link', async () => {
    const html = await renderPage();
    expect(count(html, 'data-testid="release-row"')).toBe(100);
    expect(html).not.toMatch(/class="card\b/);
    expect(html).not.toMatch(/>\s*Gated\s*</i);
    expect(html).not.toContain('Run →');
  });

  it('titles a row with its version, not the workspace name, for one workspace', async () => {
    listedReleases = history.slice(0, 1);
    totalReleases = 1;
    const html = await renderPage();
    expect(html).toMatch(/<h2[^>]*>v1\.2\.0<\/h2>/);
    expect(html).not.toContain('>Demo<');
  });

  it('renders the pending release as the one card at the top, not again as a row', async () => {
    listedReleases = [{ ...history[0], state: 'pending_external' }, ...history.slice(1, 4)];
    totalReleases = 4;
    const html = await renderPage();
    expect(count(html, /data-card="2"/g)).toBe(1);
    expect(html).toContain('data-testid="next-release"');
    expect(html).toContain('Next release');
    expect(count(html, 'href="/app/releases/release-0"')).toBe(1);
    expect(html.indexOf('data-testid="next-release"')).toBeLessThan(html.indexOf('href="/app/releases/release-1"'));
  });

  it('has no card when nothing is going out', async () => {
    listedReleases = history.slice(0, 3);
    totalReleases = 3;
    const html = await renderPage();
    expect(html).not.toContain('data-testid="next-release"');
    expect(html).not.toContain('data-card="2"');
  });
});

describe('ReleasesPage successor resolution', () => {
  for (const version of ['v1.2.4', null]) {
    it(`keeps the successor link with version ${version}`, async () => {
      listedReleases = [{ ...history[0], state: 'failed', failureReason: 'superseded by release newer' }];
      successors = [{ id: 'newer', version }];
      const html = await renderPage();
      expect(html).toContain('data-state="queued"');
      expect(html).toContain('href="/app/releases/newer"');
      expect(html).toContain(`>${version ?? 'a newer release'}</a>`);
      expect(html).not.toContain('superseded by release newer');
      expect(html).not.toContain('text-status-error');
    });
  }

  it('uses a neutral fallback without a broken link for a missing successor', async () => {
    listedReleases = [{ ...history[0], state: 'failed', failureReason: 'superseded by release missing' }];
    const html = await renderPage();
    expect(html).toContain('data-state="queued"');
    expect(html).not.toContain('href="/app/releases/missing"');
    expect(html).not.toContain('superseded by release missing');
    expect(html).not.toContain('text-status-error');
  });
});
