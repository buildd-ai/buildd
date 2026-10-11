import { describe, it, expect, afterEach, beforeEach } from 'bun:test';

// No module mocks on purpose: this route must not touch the database (or any
// other network dependency) at all, so importing it live and asserting on the
// response is itself the proof that it works with no database available.
import { installPrompts, resetPrompts } from '@buildd/core/prompts';
import { promptContentHash } from '@buildd/core/prompts-source';
import { GET } from './route';

const realFetch = globalThis.fetch;
// The control plane Worker's health, as the route will see it; null = it does not answer.
let workerHealth: Record<string, unknown> | null = null;
const seenUrls: string[] = [];

describe('GET /api/deploy-identity', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    workerHealth = null;
    seenUrls.length = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      seenUrls.push(String(input));
      if (!workerHealth) throw new Error('connect ECONNREFUSED');
      return Response.json(workerHealth);
    }) as typeof fetch;
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    globalThis.fetch = realFetch;
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
      controlPlane: null,
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
    expect(data).toEqual({ sha: null, environment: null, deploymentId: null, controlPlane: null, prompts: { active: [], fallbacks: {} } });
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

  it('reports the control plane Worker\'s commit beside the web app\'s, and whether they match', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc123';
    workerHealth = { ok: true, service: 'control-plane', mode: 'own', commit: 'abc123' };
    expect((await (await GET()).json()).controlPlane).toEqual({ commit: 'abc123', mode: 'own', lockstep: true });
    expect(seenUrls).toEqual(['https://control-plane.buildd.dev/__control-plane/health']);

    workerHealth = { ok: true, service: 'control-plane', mode: 'own', commit: 'old999' };
    expect((await (await GET()).json()).controlPlane).toEqual({ commit: 'old999', mode: 'own', lockstep: false });

    // A Worker build that predates the commit field: commit unknown, lockstep unknown.
    workerHealth = { ok: true, service: 'control-plane', mode: 'own' };
    expect((await (await GET()).json()).controlPlane).toEqual({ commit: null, mode: 'own', lockstep: null });
  });

  it('answers with controlPlane null, not an error, when the Worker is down or slow', async () => {
    process.env.VERCEL_GIT_COMMIT_SHA = 'abc123';
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).controlPlane).toBeNull();

    // A hang is cut off by the timeout signal.
    globalThis.fetch = ((_: RequestInfo | URL, init?: RequestInit) => new Promise((_r, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    })) as typeof fetch;
    const started = Date.now();
    expect((await (await GET()).json()).controlPlane).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
