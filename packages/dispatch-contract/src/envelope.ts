// The wire contract between a producer and the Dispatch transport.
//
// Dispatch owns the delivery lifecycle of an envelope (when to attempt, retry,
// collapse, give up). The producer owns everything that decides *whether*
// something should run: Dispatch never branches on `labels`, never reads
// `subject`, and its `skip` only ever comes from the producer's resolve answer
// or `expiresAt`. Nothing here names a producer table.
//
// Design: knowledge-base buildd/design/cloudflare-dispatch-transport.md.

export const ENVELOPE_KINDS = [
  'work_execution',
  'human_action',
  'notification',
  'incident',
  'external_work',
] as const;
export type EnvelopeKind = (typeof ENVELOPE_KINDS)[number];

export type StepMode = 'first' | 'also';

export interface RouteStep {
  /** Registered target id within the scope, e.g. `buildd:ws:<uuid>:webhook`. */
  target: string;
  /** `first`: exclusive chain, tried in order until one delivers or skips.
   *  `also`: side delivery alongside the chain, first attempt only. */
  mode: StepMode;
  /** Ask the producer before delivering (eligibility, payload, grant). */
  resolve?: boolean;
}

export interface DispatchEnvelope {
  /** Producer-assigned id. Idempotency key for publish; `dispatchId` for consumers. */
  id: string;
  kind: EnvelopeKind;
  source: {
    /** Producing system. Selects callback base URL and signing secret. */
    system: string;
    /** Tenancy partition, e.g. `workspace:<uuid>`. Selects the queue. */
    scope: string;
    /** Entity the intent is about. Opaque to Dispatch. */
    subject?: string;
  };
  target: { steps: RouteStep[] };
  /** ISO timestamp. Omitted means due now. */
  notBefore?: string;
  /** Collapse key within the scope. */
  dedupeKey?: string;
  /** Producer reference resolved only through the resolve callback. */
  payloadRef?: string;
  /** Small, non-secret inline payload (see MAX_INLINE_PAYLOAD_BYTES). */
  payload?: Record<string, unknown>;
  /** Observability only. Dispatch never branches on these. */
  labels?: { cause: string; causes: string[] };
  /** Attempts already made before publish (0 for a fresh producer). */
  attempt: number;
  /** ISO timestamp after which an undelivered intent closes as expired. */
  expiresAt?: string;
}

export const MAX_INLINE_PAYLOAD_BYTES = 4096;
export const MAX_PUBLISH_BATCH = 100;

// ── publish ────────────────────────────────────────────────────────────────

export interface PublishRequest {
  envelopes: DispatchEnvelope[];
}

export type PublishResult =
  | { id: string; status: 'accepted' }
  | { id: string; status: 'duplicate' }
  | { id: string; status: 'merged'; into: string }
  | { id: string; status: 'rejected'; why: string };

export interface PublishResponse {
  results: PublishResult[];
}

// ── resolve (Dispatch → producer, before a `resolve: true` step) ──────────

export interface ResolveRequest {
  id: string;
  attempt: number;
  target: string;
}

export type ResolveResponse =
  | {
      decision: 'deliver';
      /** Body Dispatch sends to the destination. */
      payload: Record<string, unknown>;
      /** Short-lived capability for this one delivery. Never persisted by Dispatch. */
      grant?: { url: string; headers: Record<string, string>; expiresAt?: string };
    }
  | { decision: 'decline'; why: string }
  | { decision: 'skip'; why: string }
  | { decision: 'reschedule'; notBefore: string };

// ── relay (interim runner wake through the producer) ──────────────────────

export interface RelayRequest {
  id: string;
  attempt: number;
  target: string;
  payload?: Record<string, unknown>;
}

export type RelayResponse =
  | { outcome: 'delivered'; via: string }
  | { outcome: 'declined'; why: string }
  | { outcome: 'skipped'; why: string };

// ── receipts (Dispatch → producer, batched, idempotent) ───────────────────

export const RECEIPT_EVENTS = ['attempted', 'delivered', 'failed', 'merged', 'expired'] as const;
export type ReceiptEvent = (typeof RECEIPT_EVENTS)[number];

export interface Receipt {
  id: string;
  attempt: number;
  event: ReceiptEvent;
  /** `delivered`: how (e.g. `webhook`, `relay:pusher`, `skipped:<why>`). */
  via?: string;
  /** `attempted`/`failed`: the error. `expired`: why. */
  why?: string;
  /** `merged`: the id this one was folded into. */
  into?: string;
  /** ISO timestamp of the event. */
  at: string;
}

export interface ReceiptsRequest {
  receipts: Receipt[];
}

export interface ReceiptsResponse {
  applied: number;
}

// ── validation ────────────────────────────────────────────────────────────

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const isIso = (v: unknown) => typeof v === 'string' && !Number.isNaN(Date.parse(v));

/** Structural check for an envelope arriving over the wire. Returns the reason it is invalid, or null. */
export function envelopeProblem(e: unknown): string | null {
  if (!isObj(e)) return 'not an object';
  if (typeof e.id !== 'string' || !e.id) return 'id';
  if (!ENVELOPE_KINDS.includes(e.kind as EnvelopeKind)) return 'kind';
  const src = e.source;
  if (!isObj(src) || typeof src.system !== 'string' || !src.system || typeof src.scope !== 'string' || !src.scope) return 'source';
  if (src.subject !== undefined && typeof src.subject !== 'string') return 'source.subject';
  const tgt = e.target;
  if (!isObj(tgt) || !Array.isArray(tgt.steps) || tgt.steps.length === 0) return 'target.steps';
  for (const s of tgt.steps) {
    if (!isObj(s) || typeof s.target !== 'string' || !s.target) return 'target.steps[].target';
    if (s.mode !== 'first' && s.mode !== 'also') return 'target.steps[].mode';
    if (s.resolve !== undefined && typeof s.resolve !== 'boolean') return 'target.steps[].resolve';
  }
  if (!tgt.steps.some(s => (s as RouteStep).mode === 'first')) return 'target.steps needs a first step';
  if (e.notBefore !== undefined && !isIso(e.notBefore)) return 'notBefore';
  if (e.expiresAt !== undefined && !isIso(e.expiresAt)) return 'expiresAt';
  if (e.dedupeKey !== undefined && (typeof e.dedupeKey !== 'string' || !e.dedupeKey)) return 'dedupeKey';
  if (e.payloadRef !== undefined && typeof e.payloadRef !== 'string') return 'payloadRef';
  if (e.payload !== undefined) {
    if (!isObj(e.payload)) return 'payload';
    if (new TextEncoder().encode(JSON.stringify(e.payload)).length > MAX_INLINE_PAYLOAD_BYTES) return 'payload too large';
  }
  if (e.labels !== undefined) {
    const l = e.labels;
    if (!isObj(l) || typeof l.cause !== 'string' || !Array.isArray(l.causes) || !l.causes.every(c => typeof c === 'string')) return 'labels';
  }
  if (typeof e.attempt !== 'number' || !Number.isInteger(e.attempt) || e.attempt < 0) return 'attempt';
  return null;
}
