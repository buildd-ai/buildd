/**
 * The control plane's kernel spans to Axiom (axiom-export.ts): OTLP/HTTP JSON in the shape Axiom's
 * traces endpoint takes, one post per gathered batch, and nothing at all without the ingest token.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { AXIOM_TOKEN_ENV, CONTROL_PLANE_SERVICE, axiomSpanSink, installKernelTelemetry, resetKernelTelemetry, toOtlpTraces } from './axiom-export';
import { emitKernelSpan, type KernelSpanRecord } from '@/lib/workflow/kernel-telemetry';

afterEach(() => resetKernelTelemetry());

const span = (o: Partial<KernelSpanRecord> = {}): KernelSpanRecord => ({
  name: 'kernel.command', startMs: 1_760_000_000_000, durationMs: 42, attributes: { 'kernel.op': 'land', 'kernel.status': 200, 'kernel.ok': true, 'kernel.ratio': 0.5 }, ...o,
});

function recorder() {
  const posts: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  const f = (async (url: string, init: RequestInit) => {
    posts.push({ url, headers: init.headers as Record<string, string>, body: JSON.parse(String(init.body)) });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { posts, f };
}

describe('OTLP encoding', () => {
  it('one resource, one scope, a span per record with typed attributes, times in nanoseconds and the error status', () => {
    const out = toOtlpTraces([span(), span({ error: true, name: 'kernel.floor' })], { 'service.name': CONTROL_PLANE_SERVICE, 'node.env': 'production' }) as any;
    const rs = out.resourceSpans[0];
    expect(rs.resource.attributes).toEqual([
      { key: 'service.name', value: { stringValue: CONTROL_PLANE_SERVICE } },
      { key: 'node.env', value: { stringValue: 'production' } },
    ]);
    const [a, b] = rs.scopeSpans[0].spans;
    expect(rs.scopeSpans[0].scope.name).toBe('buildd-kernel');
    expect(a.name).toBe('kernel.command');
    expect(a.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(a.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(a.startTimeUnixNano).toBe('1760000000000000000');
    expect(a.endTimeUnixNano).toBe('1760000000042000000');
    expect(a.attributes).toEqual([
      { key: 'kernel.op', value: { stringValue: 'land' } },
      { key: 'kernel.status', value: { intValue: '200' } },
      { key: 'kernel.ok', value: { boolValue: true } },
      { key: 'kernel.ratio', value: { doubleValue: 0.5 } },
    ]);
    expect([a.status.code, b.status.code]).toEqual([1, 2]);
  });
});

describe('the sink', () => {
  it('gathers spans and posts them once, with the token and the dataset, through waitUntil', async () => {
    const { posts, f } = recorder();
    const waited: Promise<unknown>[] = [];
    const sink = axiomSpanSink({ token: 'tok', dataset: 'ds', url: 'https://axiom.test/v1/traces', resource: { 'service.name': 'x' }, fetch: f, waitUntil: () => (p) => { waited.push(p); }, delayMs: 1 });
    sink(span());
    sink(span());
    expect(waited).toHaveLength(1);
    await Promise.all(waited);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://axiom.test/v1/traces');
    expect(posts[0].headers).toMatchObject({ authorization: 'Bearer tok', 'x-axiom-dataset': 'ds', 'content-type': 'application/json' });
    expect(posts[0].body.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it('a failing post never throws', async () => {
    const sink = axiomSpanSink({ token: 't', resource: {}, fetch: (async () => { throw new Error('down'); }) as never, delayMs: 1 });
    const warn = console.warn;
    console.warn = () => {};
    try {
      sink(span());
      await sink.flush();
    } finally {
      console.warn = warn;
    }
  });
});

describe('installing', () => {
  it('without the ingest token: nothing is installed and a kernel span posts nothing', async () => {
    const { posts, f } = recorder();
    expect(installKernelTelemetry({}, () => null, { fetch: f })).toBe(false);
    emitKernelSpan(span());
    await new Promise((r) => setTimeout(r, 40));
    expect(posts).toEqual([]);
  });

  it('with it: kernel spans go to Axiom as service buildd-control-plane, in buildd-traces by default', async () => {
    const { posts, f } = recorder();
    const waited: Promise<unknown>[] = [];
    expect(installKernelTelemetry({ [AXIOM_TOKEN_ENV]: 'tok', NODE_ENV: 'production', GIT_SHA: 'abc' }, () => (p) => { waited.push(p); }, { fetch: f })).toBe(true);
    emitKernelSpan(span());
    await Promise.all(waited);
    expect(posts).toHaveLength(1);
    expect(posts[0].url).toBe('https://api.axiom.co/v1/traces');
    expect(posts[0].headers['x-axiom-dataset']).toBe('buildd-traces');
    expect(posts[0].body.resourceSpans[0].resource.attributes).toEqual(expect.arrayContaining([
      { key: 'service.name', value: { stringValue: 'buildd-control-plane' } },
      { key: 'node.env', value: { stringValue: 'production' } },
      { key: 'vcs.repository.ref.revision', value: { stringValue: 'abc' } },
    ]));
  });
});
