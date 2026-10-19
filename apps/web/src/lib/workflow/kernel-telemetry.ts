/**
 * The kernel's spans (docs/specs/workflow-kernel-library.md, Observability): one stable
 * name per thing a monitor alerts on, and one attribute contract for each, so an Axiom
 * query written today keeps matching. Pure apart from the OpenTelemetry API, so the
 * claim path pays one span start and end per door call and nothing else.
 *
 * Where a span goes:
 *  - on the web host: the OpenTelemetry API, which `instrumentation.ts` registers on
 *    Vercel (dataset `buildd-traces`); a child of the request's own span;
 *  - on the control plane: the sink its entry installs (`setKernelSpanSink`,
 *    apps/control-plane/src/axiom-export.ts), which posts OTLP to Axiom when the
 *    Worker holds an ingest token, and is not installed when it does not. With no
 *    sink the API is the Worker's no-op tracer, so a missing token costs nothing.
 *
 * Emitting never throws and never awaits.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { KernelHost } from './kernel-host';
import type { KernelPrincipal } from './command-api';

/** The span names. Renaming one breaks every monitor on it. */
export const KERNEL_SPAN = {
  /** One door call (kernel-client.ts `door` and the short doors). */
  door: 'kernel.door',
  /** A breaker opening or closing: the AttemptStarted one or the webhook doors' one. */
  breaker: 'kernel.breaker',
  /** A kernel command the web host ran itself. Zero once the control plane owns the kernel. */
  webCommand: 'kernel.web_command',
  /** A control-plane budget pass that ran out (a sweep, a webhook). */
  pass: 'kernel.pass',
  /** One kernel floor run: outbox depth and repairs. */
  floor: 'kernel.floor',
  /** One command request the control plane answered (command-api.ts). */
  command: 'kernel.command',
} as const;

export type KernelSpanName = (typeof KERNEL_SPAN)[keyof typeof KERNEL_SPAN];

/** How a door call ended. */
export type DoorOutcome = 'applied' | 'parked' | 'unavailable' | 'breaker_open' | 'skew_fallback' | 'refused' | 'failed';
/** Who called the door. */
export type DoorCaller = 'webhook' | 'claim' | 'patch' | 'cron' | 'mcp' | 'api' | 'dashboard' | 'other';

export type SpanAttributes = Record<string, string | number | boolean>;

export interface KernelSpanRecord {
  name: KernelSpanName;
  /** Epoch ms. */
  startMs: number;
  durationMs: number;
  attributes: SpanAttributes;
  /** Marks the span as an error (status ERROR). */
  error?: boolean;
}

export type KernelSpanSink = (span: KernelSpanRecord) => void;

let sink: KernelSpanSink | null = null;

/** The control plane's entry installs its exporter here; null removes it (tests). */
export function setKernelSpanSink(s: KernelSpanSink | null): void {
  sink = s;
}

const tracer = trace.getTracer('buildd-kernel');

export function emitKernelSpan(rec: KernelSpanRecord): void {
  try {
    if (sink) {
      sink(rec);
      return;
    }
    const span = tracer.startSpan(rec.name, { startTime: rec.startMs, attributes: rec.attributes });
    span.setStatus({ code: rec.error ? SpanStatusCode.ERROR : SpanStatusCode.OK });
    span.end(rec.startMs + Math.max(0, rec.durationMs));
  } catch {
    // Telemetry never reaches a door's answer.
  }
}

// ── Attribute contract ─────────────────────────────────────────────────────

const ms = (n: number) => Math.max(0, Math.round(n));

export function doorSpanAttributes(p: {
  op: string; outcome: DoorOutcome; latencyMs: number; budgetMs: number; caller: DoorCaller; host: KernelHost; pass?: string | null; errorCode?: string | null;
}): SpanAttributes {
  return {
    'kernel.op': p.op,
    'kernel.outcome': p.outcome,
    'kernel.latency_ms': ms(p.latencyMs),
    'kernel.budget_ms': ms(p.budgetMs),
    'kernel.caller': p.caller,
    'kernel.host': p.host,
    ...(p.pass ? { 'kernel.pass': p.pass } : {}),
    ...(p.errorCode ? { 'kernel.error_code': p.errorCode } : {}),
  };
}

/** Which breaker: the AttemptStarted one (claims, withdrawals, reopens) or the webhook doors' one. */
export type KernelBreaker = 'attempt_start' | 'webhook';

export function breakerSpanAttributes(p: { state: 'open' | 'closed'; breaker: KernelBreaker; op: string; skipMs: number; openMs?: number; host: KernelHost }): SpanAttributes {
  return {
    'kernel.breaker.state': p.state,
    'kernel.breaker': p.breaker,
    'kernel.op': p.op,
    'kernel.breaker.skip_ms': ms(p.skipMs),
    ...(p.state === 'closed' && p.openMs !== undefined ? { 'kernel.breaker.open_ms': ms(p.openMs) } : {}),
    'kernel.host': p.host,
  };
}

/**
 * Why the web host ran a command itself:
 *  - `no_command_key`: routing is not switched on here (no KERNEL_COMMAND_SECRET);
 *  - `shadow`: the control plane reports shadow, or EXECUTION_MODE says so;
 *  - `not_host` / `unconfigured`: own mode, but the control plane refused before running (half switched over);
 *  - `skew`: own mode, but the control plane is an older build that does not know the op.
 */
export type WebCommandReason = 'no_command_key' | 'shadow' | 'not_host' | 'unconfigured' | 'skew';

export function webCommandSpanAttributes(p: { op: string; reason: WebCommandReason; latencyMs: number }): SpanAttributes {
  const own = p.reason === 'not_host' || p.reason === 'unconfigured' || p.reason === 'skew';
  return {
    'kernel.op': p.op,
    'kernel.reason': p.reason,
    'kernel.mode': own ? 'own' : 'shadow',
    'kernel.latency_ms': ms(p.latencyMs),
    'kernel.host': 'web',
  };
}

export function passSpanAttributes(p: { label: string; budgetMs: number; submitted: number; refused: number; drainsSkipped: number; waitedMs: number; host: KernelHost }): SpanAttributes {
  return {
    'kernel.pass': p.label,
    'kernel.budget_ms': ms(p.budgetMs),
    'kernel.pass.submitted': p.submitted,
    'kernel.pass.refused': p.refused,
    'kernel.pass.drains_skipped': p.drainsSkipped,
    'kernel.pass.waited_ms': ms(p.waitedMs),
    'kernel.host': p.host,
  };
}

/** Pending rows and the age of the oldest, per outbox; null fields when the read failed. */
export interface OutboxDepth {
  parked: number;
  parkedOldestAgeS: number;
  effectsDue: number;
  effectsOldestAgeS: number;
}

/** The floor's repairs, counted per kind (each a missed event the floor made good). */
export interface FloorRepairs {
  /** GitHub facts imported for kernel deliveries (a missed webhook). */
  factsImported: number;
  /** Owed effects re-enqueued (a lost effect row). */
  effectsEnqueued: number;
  /** Deliveries recovered from a resolved trunk incident. */
  trunkRecovered: number;
  /** Treadmill cycles restarted. */
  treadmillRestarted: number;
  /** Parked door commands re-submitted and answered. */
  parkedAnswered: number;
  /** Parked door commands given up. */
  parkedDead: number;
}

export function floorSpanAttributes(p: { host: KernelHost; depth: OutboxDepth | null; repairs: FloorRepairs; errors: number }): SpanAttributes {
  const r = p.repairs;
  return {
    'kernel.host': p.host,
    ...(p.depth
      ? {
        'kernel.outbox.parked': p.depth.parked,
        'kernel.outbox.parked_oldest_age_s': ms(p.depth.parkedOldestAgeS),
        'kernel.outbox.effects_due': p.depth.effectsDue,
        'kernel.outbox.effects_oldest_age_s': ms(p.depth.effectsOldestAgeS),
      }
      : { 'kernel.outbox.unread': true }),
    'kernel.floor.repairs.facts_imported': r.factsImported,
    'kernel.floor.repairs.effects_enqueued': r.effectsEnqueued,
    'kernel.floor.repairs.trunk_recovered': r.trunkRecovered,
    'kernel.floor.repairs.treadmill_restarted': r.treadmillRestarted,
    'kernel.floor.repairs.parked_answered': r.parkedAnswered,
    'kernel.floor.repairs.parked_dead': r.parkedDead,
    'kernel.floor.repairs.total': r.factsImported + r.effectsEnqueued + r.trunkRecovered + r.treadmillRestarted + r.parkedAnswered,
    'kernel.floor.errors': p.errors,
  };
}

/** What the control plane answered one command request with. */
export type CommandOutcome = 'applied' | 'replayed' | 'failed' | 'refused' | 'unavailable' | 'in_progress';

export function commandOutcomeOf(status: number, body: { code?: unknown; replayed?: unknown } | null): CommandOutcome {
  if (status >= 200 && status < 300) return body?.replayed === true ? 'replayed' : 'applied';
  if (status === 500 && body?.code === 'command_failed') return 'failed';
  if (status === 409 && body?.code === 'in_progress') return 'in_progress';
  if (status >= 500) return 'unavailable';
  return 'refused';
}

export function commandSpanAttributes(p: { op: string | null; status: number; outcome: CommandOutcome; code?: string | null; latencyMs: number; caller?: CommandCaller; authFailure?: CommandAuthFailure }): SpanAttributes {
  return {
    'kernel.op': p.op ?? 'unknown',
    'kernel.outcome': p.outcome,
    'kernel.status': p.status,
    ...(p.caller ? { 'kernel.caller': p.caller } : {}),
    ...(p.authFailure ? { 'kernel.auth_failure': p.authFailure } : {}),
    ...(p.code ? { 'kernel.error_code': p.code } : {}),
    'kernel.latency_ms': ms(p.latencyMs),
    'kernel.host': 'control-plane',
  };
}

/** Untrusted caller hints, classified only for diagnostics; never an authentication input. */
export type CommandCaller = 'buildd-web' | 'curl' | 'python' | 'node' | 'browser' | 'other' | 'unknown';
export type CommandAuthFailure = 'missing' | 'unknown_key' | 'skew' | 'bad_signature';

/** Never export arbitrary user-agent text, routes, identities, or credential headers to telemetry. */
export function commandCallerOf(headers: Pick<Headers, 'get'>): CommandCaller {
  const agent = headers.get('user-agent') ?? '';
  if (!agent) return 'unknown';
  if (/^buildd-kernel-client\/1$/.test(agent)) return 'buildd-web';
  if (/^curl\//i.test(agent)) return 'curl';
  if (/^(python-urllib|python-requests|python-httpx)\//i.test(agent)) return 'python';
  if (/^(node|undici)(?:\/|$)/i.test(agent)) return 'node';
  if (/^Mozilla\//.test(agent)) return 'browser';
  return 'other';
}

// ── The caller ─────────────────────────────────────────────────────────────

const route = new AsyncLocalStorage<string>();

/** The control plane's entry runs each request inside this, so a door knows which route called it. */
export function withKernelRoute<T>(path: string, fn: () => T): T {
  return route.run(path, fn);
}

/** The route of the request in progress: the control plane's, else the web request span's (best effort). */
export function currentKernelRoute(): string | null {
  const here = route.getStore();
  if (here) return here;
  try {
    const span = trace.getActiveSpan() as unknown as { attributes?: Record<string, unknown>; name?: unknown } | undefined;
    const a = span?.attributes;
    const r = a?.['http.route'] ?? a?.['next.route'];
    if (typeof r === 'string' && r) return r;
    const name = typeof span?.name === 'string' ? span.name : '';
    const m = /(\/api\/\S*)/.exec(name);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** The caller a route names; null when the route says nothing. */
export function callerOfRoute(path: string | null): DoorCaller | null {
  if (!path) return null;
  if (path.startsWith('/api/github/webhook')) return 'webhook';
  if (path === '/api/workers/claim') return 'claim';
  if (/^\/api\/workers\/(\[id\]|:id|[^/]+)$/.test(path)) return 'patch';
  if (path.startsWith('/api/cron/')) return 'cron';
  if (path.startsWith('/api/mcp')) return 'mcp';
  if (path.startsWith('/api/')) return 'api';
  return 'dashboard';
}

/**
 * Who called a door: the door's own word, else the request's route, else the control-plane pass it
 * runs in (a claim's start, a sweep), else what its principal says. `other` when nothing does.
 */
export function inferDoorCaller(p: { explicit?: DoorCaller | null; route?: string | null; pass?: string | null; principal: KernelPrincipal | null }): DoorCaller {
  if (p.explicit) return p.explicit;
  const byRoute = callerOfRoute(p.route ?? null);
  if (byRoute) return byRoute;
  const pass = p.pass ?? '';
  if (pass.startsWith('claim')) return 'claim';
  if (pass.startsWith('pr-reconcile') || pass.startsWith('sweep') || pass.startsWith('cron')) return 'cron';
  if (pass.startsWith('webhook')) return 'webhook';
  const pr = p.principal;
  if (pr?.kind === 'system') {
    if (pr.id.startsWith('system:webhook:')) return 'webhook';
    if (pr.id.startsWith('system:sweep:')) return 'cron';
  }
  if (pr?.kind === 'grant') return 'mcp';
  return 'other';
}
