import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  FALLBACK_DECISION,
  RUNNER_CLASSES,
  RUNNER_SIZE_REASONS,
  fetchRunnerSize,
  instanceTypeFor,
  normalizeRunnerSizeDecision,
  parseRunnerSizeResponse,
  runnerSeconds,
  runnerSizeRequest,
} from './runner-class';
import { RUNNER_SIZE_REASONS as SHARED_REASONS, RUNNER_SIZE_WEIGHT } from '../../../packages/shared/src/runner-size';

const TASK = '0f1e2d3c-aaaa-bbbb-cccc-000011112222';
const CFG = { BUILDD_SERVER: 'https://buildd.example/', BUILDD_API_KEY: 'bld_runner', DISPATCH_TOKEN: 'dispatch-secret' };

function fakeFetch(answer: Response | Error) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    if (answer instanceof Error) throw answer;
    return answer;
  }) as unknown as typeof fetch;
  return { fn, calls };
}

describe('runner size request (the grant path)', () => {
  test('carries the runner key and the dispatch token, which the container never holds', () => {
    const { url, init } = runnerSizeRequest(CFG, TASK, 'worker-1');
    expect(url).toBe('https://buildd.example/api/runner/runner-size');
    const h = init.headers as Record<string, string>;
    expect(h.Authorization).toBe('Bearer bld_runner');
    expect(h['X-Buildd-Dispatch-Token']).toBe('dispatch-secret');
    expect(JSON.parse(init.body as string)).toEqual({ taskId: TASK, workerId: 'worker-1' });
  });

  test('refuses to build one without both credentials', () => {
    expect(() => runnerSizeRequest({ ...CFG, DISPATCH_TOKEN: undefined }, TASK)).toThrow();
  });

  test('parses buildd\'s answer for this task only', () => {
    expect(parseRunnerSizeResponse({ taskId: TASK, runnerSize: 'large', source: 'derived', reason: 'low_disk' }, TASK))
      .toEqual({ size: 'large', source: 'derived', reason: 'low_disk' });
    expect(parseRunnerSizeResponse({ taskId: 'other', runnerSize: 'large' }, TASK)).toBeNull();
    expect(parseRunnerSizeResponse({ taskId: TASK, runnerSize: 'xl' }, TASK)).toBeNull();
  });

  test('normalize drops unknown sources and reasons', () => {
    expect(normalizeRunnerSizeDecision({ size: 'large', source: 'container', reason: 'because' })).toEqual({ size: 'large', source: 'fallback', reason: null });
    expect(normalizeRunnerSizeDecision({ size: 'standard-3' })).toBeNull();
  });
});

describe('fetchRunnerSize', () => {
  const log: string[] = [];
  const deps = (f: typeof fetch) => ({ fetch: f, log: (m: string) => log.push(m) });

  test('buildd\'s answer', async () => {
    const f = fakeFetch(Response.json({ taskId: TASK, runnerSize: 'large', source: 'explicit', reason: null }));
    expect(await fetchRunnerSize(deps(f.fn), CFG, TASK)).toEqual({ size: 'large', source: 'explicit', reason: null });
  });

  test.each([
    ['an older buildd (404)', new Response('not found', { status: 404 })],
    ['a refusal', Response.json({ error: 'Dispatch token does not match this workspace' }, { status: 403 })],
    ['a malformed answer', Response.json({ taskId: TASK, runnerSize: 'huge' })],
    ['a network error', new Error('connect ECONNREFUSED')],
  ])('%s: standard, marked as the fallback', async (_label, answer) => {
    expect(await fetchRunnerSize(deps(fakeFetch(answer).fn), CFG, TASK)).toEqual(FALLBACK_DECISION);
  });

  test('unconfigured: standard, without a request', async () => {
    const f = fakeFetch(Response.json({}));
    expect(await fetchRunnerSize(deps(f.fn), { BUILDD_SERVER: CFG.BUILDD_SERVER }, TASK)).toEqual(FALLBACK_DECISION);
    expect(f.calls).toHaveLength(0);
  });
});

describe('classes', () => {
  test('weights mirror the shared fair-use weights; reasons mirror the shared list', () => {
    expect(RUNNER_CLASSES.standard.weight).toBe(RUNNER_SIZE_WEIGHT.standard);
    expect(RUNNER_CLASSES.large.weight).toBe(RUNNER_SIZE_WEIGHT.large);
    expect([...RUNNER_SIZE_REASONS]).toEqual([...SHARED_REASONS]);
  });

  test('wrangler.jsonc has one container class per size, with its own instance type and max_instances', () => {
    const text = readFileSync(join(import.meta.dir, '..', 'wrangler.jsonc'), 'utf8').replace(/^\s*\/\/.*$/gm, '');
    const cfg = JSON.parse(text) as {
      containers: Array<{ class_name: string; instance_type: string; max_instances: number }>;
      durable_objects: { bindings: Array<{ name: string; class_name: string }> };
      migrations: Array<{ new_sqlite_classes?: string[] }>;
      vars: Record<string, string>;
    };
    for (const size of ['standard', 'large'] as const) {
      const cls = RUNNER_CLASSES[size];
      const container = cfg.containers.find(c => c.class_name === cls.binding);
      expect(container?.instance_type).toBe(cls.instanceType);
      expect(container!.max_instances).toBeGreaterThan(0);
      expect(cfg.durable_objects.bindings).toContainEqual({ name: cls.binding, class_name: cls.binding });
      expect(cfg.migrations.flatMap(m => m.new_sqlite_classes ?? [])).toContain(cls.binding);
      expect(instanceTypeFor(size, cfg.vars)).toBe(cls.instanceType);
    }
  });

  test('instanceTypeFor falls back to the class default', () => {
    expect(instanceTypeFor('large', {})).toBe('standard-3');
    expect(instanceTypeFor('standard', {})).toBe('standard-1');
  });
});

describe('runnerSeconds (fair-use hook)', () => {
  test('rounded up, weighted 1 for standard and 2 for large', () => {
    expect(runnerSeconds('standard', 1_000, 61_500)).toEqual({ seconds: 61, weighted: 61 });
    expect(runnerSeconds('large', 1_000, 61_500)).toEqual({ seconds: 61, weighted: 122 });
  });

  test('null when the container never ran', () => {
    expect(runnerSeconds('large', null, 5_000)).toBeNull();
    expect(runnerSeconds('large', 5_000, 1_000)).toBeNull();
  });
});
