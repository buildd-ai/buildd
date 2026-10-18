/**
 * The Settings Deploy steps with injected deps: a re-run only does what
 * changed. `check` reports the steps already current and writes nothing.
 */
import { describe, it, expect, mock } from 'bun:test';
import { DISPATCH_EVENTS } from '../../../../cloud-runner/src/deploy-plan';
import { runCloudRunnerDeployStep, type CloudRunnerDeployContext, type CloudRunnerDeployDeps, type StoredWebhook } from './cloud-runner-deploy';
import type { DeploymentOperation } from './action';

const WS = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const WORKER_URL = 'https://buildd-cloud-runner.example.workers.dev';
const DISPATCH = `${WORKER_URL}/dispatch`;
const ALL_SECRETS = ['BUILDD_API_KEY', 'BUILDD_SERVER', 'DISPATCH_TOKEN'];
const POINTED: StoredWebhook = { url: DISPATCH, token: 'stored-token', enabled: true, events: [...DISPATCH_EVENTS] };

const BUNDLE = {
  schema: 1, tag: 'v1.2.3', image: `docker.io/buildd/runner@sha256:${'a'.repeat(64)}`, mainModule: 'index.js', modules: [],
  config: { name: 'buildd-cloud-runner', main: 'index.js', compatibility_date: '2026-01-01', containers: [], durable_objects: { bindings: [] }, migrations: [] },
};

interface World {
  exists?: boolean;
  secretNames?: string[];
  state?: { worker: boolean; bucket: boolean; containers: boolean } | null;
  webhook?: StoredWebhook | null;
  keyWorkspaces?: string[] | null;
}

function setup(w: World = {}) {
  const calls: Array<{ op: DeploymentOperation; params?: Record<string, unknown> }> = [];
  const state = w.state === undefined ? { worker: true, bucket: true, containers: true } : w.state;
  const action = mock(async (op: DeploymentOperation, params?: Record<string, unknown>) => {
    calls.push({ op, params });
    if (op === 'status') {
      return { status: 200, body: { result: { exists: w.exists ?? true, secretNames: w.secretNames ?? ALL_SECRETS, workersDevUrl: WORKER_URL } } };
    }
    if (op === 'release_state') {
      if (!state) return { status: 502, body: { error: 'cloudflare release_state failed' } };
      return { status: 200, body: { result: { worker: { current: state.worker }, bucket: { current: state.bucket }, containers: { current: state.containers } } } };
    }
    return { status: 200, body: { result: {} } };
  });
  const saveWebhook = mock(async () => undefined);
  const mint = mock(async () => 'bld_minted');
  const widen = mock(async () => undefined);
  const deps: CloudRunnerDeployDeps = {
    action,
    loadRelease: async () => ({ ok: true, bundle: BUNDLE as never }),
    teamWebhooks: async () => [],
    saveWebhook,
    runnerKey: {
      find: async () => (w.keyWorkspaces === null ? null : { id: 'key-1', workspaceIds: w.keyWorkspaces ?? [WS] }),
      mint, widen, remove: async () => undefined,
    },
    audit: async () => undefined,
    randomToken: () => 'fresh-token',
  };
  const ctx: CloudRunnerDeployContext = {
    teamId: 'team-1', userId: 'u1', builddServer: 'https://buildd.dev',
    workspace: { id: WS, name: 'Production', webhookConfig: w.webhook === undefined ? POINTED : w.webhook },
  };
  return { ctx, deps, calls, saveWebhook, mint, widen };
}

describe('runCloudRunnerDeployStep check: a re-run skips what is current', () => {
  it('a no-op redeploy reports every later step current, ends at check, and writes nothing', async () => {
    const { ctx, deps, calls, saveWebhook, mint, widen } = setup();
    const r = await runCloudRunnerDeployStep('check', ctx, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.detail.current).toEqual(['bucket', 'worker', 'containers', 'connect']);
    expect(r.next).toBeNull();
    expect(r.detail.dispatchUrl).toBe(DISPATCH);
    expect(calls.map((c) => c.op)).toEqual(['status', 'release_state']);
    expect(calls[1].params).toMatchObject({ release: 'v1.2.3' });
    expect(saveWebhook).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
    expect(widen).not.toHaveBeenCalled();
  });

  it('a new release runs the Worker and containers, and skips the bucket and connect', async () => {
    const { ctx, deps } = setup({ state: { worker: false, bucket: true, containers: false } });
    const r = await runCloudRunnerDeployStep('check', ctx, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.detail.current).toEqual(['bucket', 'connect']);
    expect(r.next).toBe('worker');
  });

  it('connect runs when the workspace is not yet dispatching to the Worker', async () => {
    const { ctx, deps } = setup({ webhook: { url: DISPATCH, token: 'stored-token', enabled: false, events: [] } });
    const r = await runCloudRunnerDeployStep('check', ctx, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.detail.current).toEqual(['bucket', 'worker', 'containers']);
    expect(r.next).toBe('connect');
  });

  it('connect runs when the webhook misses a dispatch event', async () => {
    const { ctx, deps } = setup({ webhook: { ...POINTED, events: ['task.created'] } });
    const r = await runCloudRunnerDeployStep('check', ctx, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.detail.current).not.toContain('connect');
  });

  it('connect runs when the runner key does not reach this workspace', async () => {
    const { ctx, deps } = setup({ keyWorkspaces: ['other-ws'] });
    const r = await runCloudRunnerDeployStep('check', ctx, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.detail.current).not.toContain('connect');
  });

  it('connect runs when a secret it puts is missing', async () => {
    const { ctx, deps } = setup({ secretNames: ['BUILDD_API_KEY', 'DISPATCH_TOKEN'] });
    const r = await runCloudRunnerDeployStep('check', ctx, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.detail.current).not.toContain('connect');
  });

  it('a first deploy runs every step and does not read release state', async () => {
    const { ctx, deps, calls } = setup({ exists: false, secretNames: [], webhook: null });
    const r = await runCloudRunnerDeployStep('check', ctx, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.detail.current).toEqual([]);
    expect(r.next).toBe('bucket');
    expect(calls.map((c) => c.op)).toEqual(['status']);
  });

  it('an unreadable release state skips nothing', async () => {
    const { ctx, deps } = setup({ state: null });
    const r = await runCloudRunnerDeployStep('check', ctx, deps);
    if (!r.ok) throw new Error(r.error);
    expect(r.detail.current).toEqual([]);
    expect(r.next).toBe('bucket');
  });
});
