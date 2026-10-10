import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';

const RELEASE_ID = '0f0e0d0c-0b0a-4908-8706-050403020100';
const SUCCESSOR_ID = '1f1e1d1c-1b1a-4918-9716-151413121110';

const baseRelease = {
  id: RELEASE_ID,
  workspaceId: 'ws',
  archetype: 'gated',
  state: 'healthy',
  version: 'v1.2.3',
  verificationStrategy: 'none',
  dispatchedAt: null,
  deployedAt: null,
  healthyAt: null,
  triggeredBy: 'user',
  failureReason: null as string | null,
  ciStateAtDispatch: null,
  commitsAheadAtDispatch: null,
  previousSha: null,
  headSha: null,
  runUrl: null,
  deployUrl: null,
};
let release = baseRelease;
let successor: { id: string; version: string | null } | null = null;

/** A drizzle-ish chain: every builder method returns itself, awaiting it yields []. */
function chain(result: () => unknown[]) {
  const c: any = {
    from: () => c, leftJoin: () => c, where: () => c, limit: () => c,
    then: (ok: (v: unknown[]) => unknown, err?: (e: unknown) => unknown) => Promise.resolve(result()).then(ok, err),
  };
  return c;
}

beforeEach(() => { release = baseRelease; successor = null; });
mock.module('@buildd/core/db', () => ({
  db: {
    query: {
      releases: { findFirst: async () => release },
      workspaces: { findFirst: async () => ({ id: 'ws', name: 'Demo', teamId: 'team', githubRepoId: null }) },
      githubRepos: { findFirst: async () => null },
    },
    select: (cols: Record<string, unknown>) => chain(() => ('version' in cols ? (successor ? [successor] : []) : [])),
  },
}));
mock.module('@/lib/auth-helpers', () => ({ getCurrentUser: async () => ({ id: 'demo-user' }) }));
mock.module('@/lib/team-access', () => ({ getUserTeamIds: async () => ['team'] }));
mock.module('next/navigation', () => ({
  notFound: () => { throw new Error('notFound'); },
  redirect: () => { throw new Error('redirect'); },
  useRouter: () => ({ refresh: () => {} }),
}));
mock.module('./ReleaseAutoRefresh', () => ({ default: () => null }));

const { default: ReleaseDetailPage } = await import('./page');
const renderPage = async () => renderToStaticMarkup(await ReleaseDetailPage({ params: Promise.resolve({ id: RELEASE_ID }) }));

describe('ReleaseDetailPage', () => {
  it('backs out to Releases, not a Missions breadcrumb', async () => {
    const html = await renderPage();
    expect(html).toContain('href="/app/releases"');
    expect(html).toContain('‹ Releases');
    expect(html).not.toContain('href="/app/missions"');
  });

  it('titles the page with the version and states it with a StatePill, without an archetype badge', async () => {
    const html = await renderPage();
    expect(html).toMatch(/<h1[^>]*>v1\.2\.3<\/h1>/);
    expect(html).toContain('data-state="landed"');
    expect(html).not.toMatch(/>\s*gated\s*</i);
    expect(html).not.toMatch(/upper[c]ase/);
  });

  it('shows a superseded release as grey Superseded with a version link and no raw id', async () => {
    release = { ...baseRelease, state: 'failed', failureReason: `superseded by release ${SUCCESSOR_ID} (PR merged)` };
    successor = { id: SUCCESSOR_ID, version: 'v1.2.4' };
    const html = await renderPage();
    expect(html).toContain('data-tone="q"');
    expect(html).toContain('Superseded');
    expect(html).not.toContain('Failed');
    expect(html).not.toContain('text-status-error');
    expect(html).toContain('>v1.2.4</a>');
    expect(html.replace(/<[^>]+>/g, ' ')).not.toContain(SUCCESSOR_ID);
  });

  it('keeps an ordinary failure red, shown once', async () => {
    release = { ...baseRelease, state: 'failed', failureReason: 'Deployment failed' };
    const html = await renderPage();
    expect(html).toContain('data-tone="bad"');
    expect(html.split('Deployment failed').length - 1).toBe(1);
  });
});
