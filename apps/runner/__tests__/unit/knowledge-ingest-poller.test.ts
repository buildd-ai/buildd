/**
 * Unit tests for the runner-side knowledge ingest poller (KM v2 spec §3.3,
 * stream A2): claims `full`-scope ingest jobs from the server when the runner
 * is idle and holds a checkout for the job's repo, then streams the repo's
 * files through the server's ingest routes.
 */

import { describe, test, expect } from 'bun:test';
import { KnowledgeIngestPoller } from '../../src/knowledge-ingest';
import type { FullIngestApiClient, FullIngestJob } from '@buildd/core/knowledge-store/full-ingest';

function fakeApi(job: FullIngestJob | null, overrides: Partial<FullIngestApiClient> = {}) {
  const calls = { claim: [] as string[][], completions: [] as Array<Record<string, unknown>> };
  const api: FullIngestApiClient = {
    claimJob: async (repos) => {
      calls.claim.push(repos);
      return job;
    },
    pushFiles: async (_id, files) => ({
      filesIngested: files.length,
      chunksUpserted: files.length,
      filesSkipped: 0,
      filesDeleted: 0,
    }),
    completeJob: async (_id, result) => {
      calls.completions.push(result as Record<string, unknown>);
    },
    ...overrides,
  };
  return { api, calls };
}

const job: FullIngestJob = {
  id: 'job-1',
  workspaceId: 'ws-1',
  repo: 'Test-Org/Test-Repo',
  sha: null,
  scope: 'full',
  trigger: 'backfill',
};

function makePoller(opts: {
  api: FullIngestApiClient;
  repos?: Array<{ path: string; normalizedUrl: string | null }>;
  enabled?: boolean;
  runJob?: (job: FullIngestJob, repoPath: string) => Promise<{ status: 'done' | 'error' }>;
}) {
  return new KnowledgeIngestPoller({
    enabled: opts.enabled ?? true,
    api: opts.api,
    scanRepos: () => opts.repos ?? [{ path: '/repos/test-repo', normalizedUrl: 'test-org/test-repo' }],
    executeJob: opts.runJob ?? (async () => ({ status: 'done' as const })),
    log: () => {},
  });
}

describe('KnowledgeIngestPoller', () => {
  test('does nothing when disabled', async () => {
    const { api, calls } = fakeApi(job);
    const poller = makePoller({ api, enabled: false });
    expect(await poller.poll()).toBe('disabled');
    expect(calls.claim.length).toBe(0);
  });

  test('does not claim when no local repos have remotes', async () => {
    const { api, calls } = fakeApi(job);
    const poller = makePoller({ api, repos: [{ path: '/repos/x', normalizedUrl: null }] });
    expect(await poller.poll()).toBe('idle');
    expect(calls.claim.length).toBe(0);
  });

  test('offers normalized repo slugs and runs a claimed job', async () => {
    const { api, calls } = fakeApi(job);
    let executed: FullIngestJob | null = null;
    let repoPath: string | null = null;
    const poller = makePoller({
      api,
      runJob: async (j, path) => {
        executed = j;
        repoPath = path;
        return { status: 'done' };
      },
    });
    expect(await poller.poll()).toBe('ran');
    expect(calls.claim[0]).toEqual(['test-org/test-repo']);
    expect(executed!.id).toBe('job-1');
    expect(repoPath).toBe('/repos/test-repo');
  });

  test('returns idle when the server has no matching job', async () => {
    const { api } = fakeApi(null);
    const poller = makePoller({ api });
    expect(await poller.poll()).toBe('idle');
  });

  test('matches the claimed repo to the local path case-insensitively', async () => {
    const { api } = fakeApi(job); // job.repo has different casing
    let repoPath: string | null = null;
    const poller = makePoller({
      api,
      runJob: async (_j, path) => {
        repoPath = path;
        return { status: 'done' };
      },
    });
    await poller.poll();
    expect(repoPath).toBe('/repos/test-repo');
  });

  test('completes the job as error when the claimed repo has no local checkout', async () => {
    const { api, calls } = fakeApi({ ...job, repo: 'test-org/other-repo' });
    const poller = makePoller({ api });
    expect(await poller.poll()).toBe('error');
    expect(calls.completions.length).toBe(1);
    expect(calls.completions[0].status).toBe('error');
  });

  test('refuses concurrent polls while a job is running', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(r => (release = r));
    const { api } = fakeApi(job);
    const poller = makePoller({
      api,
      runJob: async () => {
        await gate;
        return { status: 'done' as const };
      },
    });
    const first = poller.poll();
    expect(await poller.poll()).toBe('busy');
    release();
    expect(await first).toBe('ran');
  });

  // Regression: a checkout whose remote the runner cannot fetch (an SSH remote
  // with no key, a dead token) used to fall back silently to its stale HEAD, or
  // simply never make progress, and nothing said why. The runner now hands the
  // job back with the reason, and stops offering that repo for a while, so the
  // server-side fallback can take it.
  test('releases the job with the reason when its checkout cannot fetch', async () => {
    const released: Array<{ id: string; reason: string }> = [];
    const { api, calls } = fakeApi(job, {
      releaseJob: async (id, reason) => {
        released.push({ id, reason });
      },
    });
    let ran = false;
    const poller = new KnowledgeIngestPoller({
      enabled: true,
      api,
      scanRepos: () => [{ path: '/repos/test-repo', normalizedUrl: 'test-org/test-repo' }],
      executeJob: async () => {
        ran = true;
        return { status: 'done' };
      },
      checkCheckout: async () => ({ ok: false, reason: 'Permission denied (publickey).' }),
      log: () => {},
    });

    expect(await poller.poll()).toBe('released');
    expect(ran).toBe(false);
    expect(released).toEqual([{ id: 'job-1', reason: expect.stringContaining('Permission denied (publickey).') }]);
    expect(calls.completions.length).toBe(0);

    // The unfetchable repo is no longer offered on the next poll.
    expect(await poller.poll()).toBe('idle');
    expect(calls.claim.length).toBe(1);
    expect(poller.unfetchableRepos()).toEqual([
      expect.objectContaining({ repo: 'test-org/test-repo', reason: expect.stringContaining('publickey') }),
    ]);
  });

  test('runs the job when the checkout check passes', async () => {
    const { api } = fakeApi(job, { releaseJob: async () => {} });
    const checked: Array<{ path: string; sha: string | null | undefined }> = [];
    const poller = new KnowledgeIngestPoller({
      enabled: true,
      api,
      scanRepos: () => [{ path: '/repos/test-repo', normalizedUrl: 'test-org/test-repo' }],
      executeJob: async () => ({ status: 'done' }),
      checkCheckout: async (path, sha) => {
        checked.push({ path, sha });
        return { ok: true };
      },
      log: () => {},
    });
    expect(await poller.poll()).toBe('ran');
    expect(checked).toEqual([{ path: '/repos/test-repo', sha: null }]);
  });

  test('reports error outcome when execution fails', async () => {
    const { api } = fakeApi(job);
    const poller = makePoller({
      api,
      runJob: async () => ({ status: 'error' as const }),
    });
    expect(await poller.poll()).toBe('error');
  });
});
