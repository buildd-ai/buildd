import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import { NextRequest } from 'next/server';

const mockGetLatestVersion = mock((..._args: unknown[]) =>
  Promise.resolve({ latestCommit: 'sha-dev', latestTag: 'v1.2.3', updatedAt: '2026-01-01T00:00:00.000Z', branch: 'dev' }),
);
const mockTrackEvent = mock(() => {});

mock.module('@/lib/version-cache', () => ({
  getLatestVersion: mockGetLatestVersion,
  resolveVersionBranch: (b?: string | null) => (b === 'main' || b === 'dev' ? b : 'dev'),
}));

mock.module('@/lib/axiom', () => ({
  trackEvent: mockTrackEvent,
}));

import { GET } from './route';

function req(url = 'http://localhost:3000/api/version'): NextRequest {
  return new NextRequest(url, { method: 'GET' });
}

describe('GET /api/version', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    mockGetLatestVersion.mockReset();
    mockTrackEvent.mockReset();
    mockGetLatestVersion.mockResolvedValue({
      latestCommit: 'sha-dev', latestTag: 'v1.2.3', updatedAt: '2026-01-01T00:00:00.000Z', branch: 'dev',
    });
  });

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports the deployed block from the Vercel build env, independent of GitHub', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'deployed-sha';
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_123';

    const res = await GET(req());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.deployed.sha).toBe('deployed-sha');
    expect(data.deployed.environment).toBe('production');
    expect(data.deployed.deploymentId).toBe('dpl_123');
    expect(typeof data.deployed.version).toBe('string');
  });

  it('reports deployed as all-null in an environment with no Vercel env vars (local dev)', async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_DEPLOYMENT_ID;

    const res = await GET(req());
    const data = await res.json();

    expect(data.deployed.sha).toBeNull();
    expect(data.deployed.environment).toBeNull();
    expect(data.deployed.deploymentId).toBeNull();
  });

  it('honours a ?branch= query param for latestAvailable, via the version-cache allowlist', async () => {
    mockGetLatestVersion.mockResolvedValue({
      latestCommit: 'sha-main', latestTag: null, updatedAt: '2026-01-02T00:00:00.000Z', branch: 'main',
    });

    const res = await GET(req('http://localhost:3000/api/version?branch=main'));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetLatestVersion.mock.calls[0][0]).toBe('main');
    expect(data.latestAvailable.branch).toBe('main');
    expect(data.latestAvailable.commit).toBe('sha-main');
    expect(data.latestAvailable.tag).toBeNull();
    expect(data.latestAvailable.error).toBeNull();
  });

  it('defaults latestAvailable to the version-cache default branch when no ?branch= is given', async () => {
    const res = await GET(req());
    expect(mockGetLatestVersion.mock.calls[0][0]).toBeNull();
  });

  it('calls getLatestVersion with tolerateStale: false, so a GitHub blip cannot silently serve a stale cache', async () => {
    await GET(req());
    expect(mockGetLatestVersion.mock.calls[0][1]).toEqual({ tolerateStale: false });
  });

  it('degrades to deployed-only with an explicit error when GitHub is unreachable — never a 502', async () => {
    mockGetLatestVersion.mockRejectedValue(new Error('GitHub API error: 503'));
    process.env.VERCEL_GIT_COMMIT_SHA = 'deployed-sha';

    const res = await GET(req());
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.deployed.sha).toBe('deployed-sha');
    expect(data.latestAvailable.commit).toBeNull();
    expect(data.latestAvailable.tag).toBeNull();
    expect(data.latestAvailable.error).toBe('GitHub API error: 503');
  });

  it('sets a no-store Cache-Control header so a CDN never serves a stale deploy\'s answer', async () => {
    const res = await GET(req());
    expect(res.headers.get('Cache-Control')).toBe('no-store');
  });
});
