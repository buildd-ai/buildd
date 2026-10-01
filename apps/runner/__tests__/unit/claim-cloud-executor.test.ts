/**
 * BuilddClient.claimTask and the cloud executor marker (task bb423c8a):
 * BUILDD_EXECUTOR is sent on the claim verbatim, and for `cloud` any
 * credential field that arrives anyway is dropped before the worker manager
 * can write it into a session config dir.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/claim-cloud-executor.test.ts
 */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { CLAIM_CREDENTIAL_FIELDS } from '@buildd/shared';
import { BuilddClient } from '../../src/buildd';
import type { LocalUIConfig } from '../../src/types';

const realFetch = globalThis.fetch;
const realError = console.error;
const realExecutor = process.env.BUILDD_EXECUTOR;

function makeClient(extra: Partial<LocalUIConfig> = {}) {
  return new BuilddClient({
    projectsRoot: '/tmp',
    builddServer: 'http://server.invalid',
    apiKey: 'test-key',
    maxConcurrent: 1,
    ...extra,
  } as LocalUIConfig);
}

/** A worker as an old or misbehaving server might return it: every credential field set. */
function workerWithEveryCredential(): Record<string, unknown> {
  const w: Record<string, unknown> = { id: 'w-1', taskId: 't-1', branch: 'b', task: { id: 't-1' } };
  for (const f of CLAIM_CREDENTIAL_FIELDS) w[f] = `leaked-${f}`;
  return w;
}

let sentBodies: any[];
function respond(workers: unknown[]) {
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    sentBodies.push(JSON.parse(String(init.body)));
    const body = JSON.stringify({ workers });
    return { ok: true, status: 200, text: async () => body, json: async () => JSON.parse(body) };
  }) as any;
}

describe('claimTask executor marker', () => {
  beforeEach(() => {
    sentBodies = [];
    console.error = () => {};
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realError;
    if (realExecutor === undefined) delete process.env.BUILDD_EXECUTOR;
    else process.env.BUILDD_EXECUTOR = realExecutor;
  });

  test('BUILDD_EXECUTOR=cloud is sent and every credential field is dropped', async () => {
    process.env.BUILDD_EXECUTOR = 'cloud';
    respond([workerWithEveryCredential()]);
    const { workers } = await makeClient().claimTask(1, 'ws-1', 'r', 't-1');
    expect(sentBodies[0].executor).toBe('cloud');
    for (const f of CLAIM_CREDENTIAL_FIELDS) expect(workers[0][f]).toBeUndefined();
    expect(JSON.stringify(workers)).not.toContain('leaked-');
    expect(workers[0].id).toBe('w-1');
  });

  test('an unknown value is sent verbatim (the server refuses it), not dropped', async () => {
    process.env.BUILDD_EXECUTOR = 'Cloud';
    respond([]);
    await makeClient().claimTask(1);
    expect(sentBodies[0].executor).toBe('Cloud');
  });

  test('unset: no marker and the claim is untouched', async () => {
    delete process.env.BUILDD_EXECUTOR;
    respond([workerWithEveryCredential()]);
    const { workers } = await makeClient().claimTask(1);
    expect('executor' in sentBodies[0]).toBe(false);
    expect(workers[0].serverApiKey).toBe('leaked-serverApiKey');
  });
});

describe('agent model endpoint on the claim (docs/design/agent-model-endpoint.md)', () => {
  beforeEach(() => { sentBodies = []; console.error = () => {}; });
  afterEach(() => {
    globalThis.fetch = realFetch;
    console.error = realError;
    if (realExecutor === undefined) delete process.env.BUILDD_EXECUTOR;
    else process.env.BUILDD_EXECUTOR = realExecutor;
  });

  test('modelEndpoint is a credential field, so a cloud claim drops it', async () => {
    expect(CLAIM_CREDENTIAL_FIELDS as readonly string[]).toContain('modelEndpoint');
    process.env.BUILDD_EXECUTOR = 'cloud';
    respond([{ id: 'w-1', taskId: 't-1', modelEndpoint: { kind: 'gateway', baseUrl: 'https://litellm.example.com', authToken: 'leaked-endpoint-key', authHeader: 'authorization', models: {} } }]);
    const { workers } = await makeClient().claimTask(1, 'ws-1', 'r', 't-1');
    expect(workers[0].modelEndpoint).toBeUndefined();
    expect(JSON.stringify(workers)).not.toContain('leaked-endpoint-key');
  });

  test('llmProviderOverride: true when a per-machine provider is configured, a boolean only', async () => {
    delete process.env.BUILDD_EXECUTOR;
    respond([]);
    await makeClient({ llmProvider: { provider: 'openrouter', apiKey: 'machine-key', baseUrl: 'https://openrouter.ai/api' } }).claimTask(1);
    expect(sentBodies[0].llmProviderOverride).toBe(true);
    expect(JSON.stringify(sentBodies[0])).not.toContain('machine-key');
  });

  test('no per-machine provider: llmProviderOverride is false', async () => {
    delete process.env.BUILDD_EXECUTOR;
    respond([]);
    await makeClient().claimTask(1);
    expect(sentBodies[0].llmProviderOverride).toBe(false);
  });

  test('the claim declares endpoint support, so the server may send modelEndpoint', async () => {
    delete process.env.BUILDD_EXECUTOR;
    respond([]);
    await makeClient().claimTask(1);
    const { AGENT_ENDPOINT_RUNNER_FEATURE } = await import('@buildd/core/agent-endpoint');
    expect(AGENT_ENDPOINT_RUNNER_FEATURE).toBe('agent_endpoint');
    expect(sentBodies[0].runnerFeatures).toContain(AGENT_ENDPOINT_RUNNER_FEATURE);
    expect(sentBodies[0].runnerFeatures).toContain('cbm_withhold');
  });
});
