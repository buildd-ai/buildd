import { describe, it, expect, afterEach } from 'bun:test';

// No module mocks on purpose: this route must not touch the database (or any
// other network dependency) at all, so importing it live and asserting on the
// response is itself the proof that it works with no database available.
import { GET } from './route';

describe('GET /api/deploy-identity', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
  });

  it('reports the running sha, environment, and deployment id from the Vercel build env', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc123def456';
    process.env.VERCEL_ENV = 'production';
    process.env.VERCEL_DEPLOYMENT_ID = 'dpl_xyz789';

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({
      sha: 'abc123def456',
      environment: 'production',
      deploymentId: 'dpl_xyz789',
    });
  });

  it('returns nulls instead of throwing when Vercel env vars are unset (e.g. local dev)', async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_DEPLOYMENT_ID;

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ sha: null, environment: null, deploymentId: null });
  });
});
