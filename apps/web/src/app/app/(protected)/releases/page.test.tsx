import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

// Synthetic history exceeds the list fetch cap.
const history = Array.from({ length: 101 }, (_, i) => ({
  id: `release-${i}`,
  workspaceId: 'demo-workspace',
  archetype: 'gated',
  state: 'healthy',
  failureReason: null as string | null,
  version: 'v1.2.3',
  releaseTasks: [],
}));
let listedReleases = history;
let successors: { id: string; version: string | null }[] = [];
const findMany = mock(async ({ limit }: { limit: number }) => listedReleases.slice(0, limit));
beforeEach(() => { listedReleases = history; successors = []; });
mock.module('@buildd/core/db', () => ({
  db: {
    select: (columns: { version?: unknown }) => ({
      from: () => ({
        where: async () => columns.version ? successors : [{
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

describe('ReleasesPage header', () => {
  it('does not present the capped result length as the total release count', async () => {
    const html = renderToStaticMarkup(await ReleasesPage({ searchParams: Promise.resolve({}) }));
    expect(findMany).toHaveBeenCalled();
    expect(html.match(/class="card card-interactive/g)?.length).toBe(100);
    const header = html.slice(0, html.indexOf('<div class="space-y-2">'));
    expect(header).toContain('Releases</h1>');
    expect(header).not.toMatch(/\d+ releases/);
  });
});

describe('ReleasesPage successor resolution', () => {
  for (const version of ['v1.2.4', null]) {
    it(`keeps the successor link with version ${version}`, async () => {
      listedReleases = [{ ...history[0], state: 'failed', failureReason: 'superseded by release newer' }];
      successors = [{ id: 'newer', version }];
      const html = renderToStaticMarkup(await ReleasesPage({ searchParams: Promise.resolve({}) }));
      expect(html).toContain('data-state="queued"');
      expect(html).toContain('href="/app/releases/newer"');
      expect(html).toContain(`>${version ?? 'a newer release'}</a>`);
      expect(html).not.toContain('superseded by release newer');
      expect(html).not.toContain('text-status-error');
    });
  }

  it('uses a neutral fallback without a broken link for a missing successor', async () => {
    listedReleases = [{ ...history[0], state: 'failed', failureReason: 'superseded by release missing' }];
    const html = renderToStaticMarkup(await ReleasesPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('data-state="queued"');
    expect(html).not.toContain('href="/app/releases/missing"');
    expect(html).not.toContain('superseded by release missing');
    expect(html).not.toContain('text-status-error');
  });
});
