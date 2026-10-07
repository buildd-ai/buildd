import { describe, it, expect, afterEach } from 'bun:test';

// No module mocks on purpose: this route must not touch the database (or any
// other network dependency) at all, so importing it live and asserting on the
// response is itself the proof that it works with no database available.
import { installPrompts, resetPrompts } from '@buildd/core/prompts';
import { promptContentHash } from '@buildd/core/prompts-source';
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
      prompts: { active: [], fallbacks: {} },
    });
  });

  it('returns nulls instead of throwing when Vercel env vars are unset (e.g. local dev)', async () => {
    delete process.env.VERCEL_GIT_COMMIT_SHA;
    delete process.env.VERCEL_ENV;
    delete process.env.VERCEL_DEPLOYMENT_ID;

    const res = await GET();
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ sha: null, environment: null, deploymentId: null, prompts: { active: [], fallbacks: {} } });
  });

  it('lists active prompt fingerprints (id, version, hash) and never the text', async () => {
    const body = 'private prompt words';
    installPrompts([{ id: 'test.p', version: 3, body, contentHash: promptContentHash(body) }]);
    try {
      const res = await GET();
      const text = await res.text();
      expect(JSON.parse(text).prompts.active).toEqual([{ id: 'test.p', version: 3, contentHash: promptContentHash(body) }]);
      expect(text).not.toContain(body);
    } finally {
      resetPrompts();
    }
  });
});
