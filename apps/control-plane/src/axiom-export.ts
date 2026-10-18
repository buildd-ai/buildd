/**
 * The control plane's kernel spans to Axiom (docs/specs/workflow-kernel-library.md, Observability).
 * The Worker registers no OpenTelemetry SDK, so the kernel's spans (lib/workflow/kernel-telemetry.ts)
 * come here instead: buffered per request, posted as OTLP/HTTP JSON to Axiom's traces endpoint
 * after the response (waitUntil), into the same dataset the web host's Vercel spans land in, under
 * service `buildd-control-plane`. One query then covers both hosts.
 *
 * Needs the Worker secret `AXIOM_INGEST_TOKEN` (an Axiom API token with ingest rights on the dataset).
 * Without it nothing is installed and the kernel's spans go to the no-op tracer: no request, no cost.
 * Optional vars: `AXIOM_TRACES_DATASET` (default `buildd-traces`), `AXIOM_OTLP_URL` (default the US
 * region's `https://api.axiom.co/v1/traces`).
 */
import { setKernelSpanSink, type KernelSpanRecord, type KernelSpanSink, type SpanAttributes } from '@/lib/workflow/kernel-telemetry';

export const AXIOM_TOKEN_ENV = 'AXIOM_INGEST_TOKEN';
export const DEFAULT_AXIOM_DATASET = 'buildd-traces';
export const DEFAULT_AXIOM_OTLP_URL = 'https://api.axiom.co/v1/traces';
export const CONTROL_PLANE_SERVICE = 'buildd-control-plane';
/** How long the sink gathers spans before one post: a request's door and command spans go together. */
export const FLUSH_DELAY_MS = 25;
/** A burst (a floor pass) is posted in batches of at most this many spans. */
export const MAX_BATCH = 200;

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
const otlpValue = (v: string | number | boolean): OtlpValue =>
  typeof v === 'boolean' ? { boolValue: v } : typeof v === 'number' ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v };
const otlpAttributes = (a: SpanAttributes) => Object.entries(a).map(([key, value]) => ({ key, value: otlpValue(value) }));

const hex = (bytes: number) => {
  const b = new Uint8Array(bytes);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
};
const nanos = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

/** OTLP/HTTP JSON for one batch: each span is a root span of its own trace, kind INTERNAL. */
export function toOtlpTraces(spans: KernelSpanRecord[], resource: SpanAttributes): Record<string, unknown> {
  return {
    resourceSpans: [{
      resource: { attributes: otlpAttributes(resource) },
      scopeSpans: [{
        scope: { name: 'buildd-kernel' },
        spans: spans.map((s) => ({
          traceId: hex(16), spanId: hex(8), name: s.name, kind: 1,
          startTimeUnixNano: nanos(s.startMs), endTimeUnixNano: nanos(s.startMs + Math.max(0, s.durationMs)),
          attributes: otlpAttributes(s.attributes),
          status: { code: s.error ? 2 : 1 },
        })),
      }],
    }],
  };
}

export interface AxiomSinkOptions {
  token: string;
  dataset?: string;
  url?: string;
  resource: SpanAttributes;
  fetch?: typeof fetch;
  /** The current request's waitUntil, so a post outlives the response; null outside a request. */
  waitUntil?: () => ((p: Promise<unknown>) => void) | null;
  delayMs?: number;
}

/** A sink that gathers spans for `delayMs` and posts them in one request. Never throws. */
export function axiomSpanSink(o: AxiomSinkOptions): KernelSpanSink & { flush: () => Promise<void> } {
  let buffer: KernelSpanRecord[] = [];
  let pending: Promise<void> | null = null;
  let warned = false;
  const post = async (batch: KernelSpanRecord[]) => {
    try {
      const res = await (o.fetch ?? fetch)(o.url ?? DEFAULT_AXIOM_OTLP_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${o.token}`, 'x-axiom-dataset': o.dataset ?? DEFAULT_AXIOM_DATASET, 'content-type': 'application/json' },
        body: JSON.stringify(toOtlpTraces(batch, o.resource)),
      });
      if (!res.ok && !warned) {
        warned = true;
        console.warn(`[kernel-telemetry] Axiom refused the kernel spans (${res.status}); check ${AXIOM_TOKEN_ENV} and the dataset`);
      }
    } catch (err) {
      if (!warned) {
        warned = true;
        console.warn('[kernel-telemetry] the kernel spans could not be posted to Axiom:', err instanceof Error ? err.message : err);
      }
    }
  };
  const flush = async () => {
    pending = null;
    while (buffer.length) {
      const batch = buffer.slice(0, MAX_BATCH);
      buffer = buffer.slice(MAX_BATCH);
      await post(batch);
    }
  };
  const sink = ((span: KernelSpanRecord) => {
    buffer.push(span);
    if (pending) return;
    const delay = o.delayMs ?? FLUSH_DELAY_MS;
    pending = new Promise<void>((r) => setTimeout(r, delay)).then(flush);
    try { o.waitUntil?.()?.(pending); } catch { /* outside a request: the timer still fires */ }
  }) as KernelSpanSink & { flush: () => Promise<void> };
  sink.flush = async () => { await (pending ?? flush()); };
  return sink;
}

let installed = false;

/**
 * Install the sink once, when the Worker holds the ingest token; a no-op without it (and the kernel's
 * spans stay on the no-op tracer). True when installed.
 */
export function installKernelTelemetry(env: Record<string, string | undefined>, waitUntil: AxiomSinkOptions['waitUntil'], o: { force?: boolean; fetch?: typeof fetch } = {}): boolean {
  if (installed && !o.force) return true;
  const token = env[AXIOM_TOKEN_ENV];
  if (!token) return false;
  setKernelSpanSink(axiomSpanSink({
    token,
    dataset: env.AXIOM_TRACES_DATASET || DEFAULT_AXIOM_DATASET,
    url: env.AXIOM_OTLP_URL || DEFAULT_AXIOM_OTLP_URL,
    resource: {
      'service.name': CONTROL_PLANE_SERVICE,
      'node.env': env.NODE_ENV || 'production',
      env: env.VERCEL_ENV || 'production',
      ...(env.GIT_SHA ? { 'vcs.repository.ref.revision': env.GIT_SHA } : {}),
    },
    waitUntil,
    fetch: o.fetch,
  }));
  installed = true;
  return true;
}

/** Tests. */
export function resetKernelTelemetry(): void {
  installed = false;
  setKernelSpanSink(null);
}
