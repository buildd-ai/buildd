// The adapter contract (design "Adapter contract"). An adapter performs one
// delivery to one target. It returns delivered/declined/skipped; a throw is
// retryable. Adapters never persist anything: a grant passed in `resolved`
// lives only for the duration of `deliver`.

import type { DispatchEnvelope, ResolveResponse, RouteStep } from '@buildd/dispatch-contract';

export const TARGET_TYPES = ['http', 'runner-wake'] as const;
export type TargetType = (typeof TARGET_TYPES)[number];

export type ResolvedDeliver = Extract<ResolveResponse, { decision: 'deliver' }>;

/** Non-secret per-target options from the targets table. */
export interface TargetOptions {
  /** Outbound timeout for http-like adapters. */
  timeoutMs?: number;
  [k: string]: unknown;
}

export interface DeliveryContext {
  id: string;
  /** 1-based number of this attempt. */
  attempt: number;
  target: string;
  envelope: DispatchEnvelope;
  options: TargetOptions;
}

export type AdapterOutcome =
  | { kind: 'delivered'; via: string }
  | { kind: 'declined'; why: string }
  | { kind: 'skipped'; why: string };

export interface TransportAdapter {
  type: TargetType;
  /** The engine always calls resolve before this adapter (it needs a grant). */
  needsResolve: boolean;
  /** Throw = retryable. */
  deliver(ctx: DeliveryContext, step: RouteStep, resolved?: ResolvedDeliver): Promise<AdapterOutcome>;
}

export type AdapterRegistry = Partial<Record<TargetType, TransportAdapter>>;

export type FetchFn = (input: string, init: RequestInit) => Promise<Response>;

/**
 * Target-id suffix (after the last `:`) → adapter type, for unregistered
 * targets. `github-actions` is gone on purpose: an intent queued before it
 * was removed declines that step as `unknown_target` and moves on.
 */
const SUFFIX_TYPES: Record<string, TargetType> = {
  webhook: 'http',
  http: 'http',
  'runner-wake': 'runner-wake',
};

export function targetTypeFromId(target: string): TargetType | null {
  const suffix = target.slice(target.lastIndexOf(':') + 1);
  return Object.prototype.hasOwnProperty.call(SUFFIX_TYPES, suffix) ? SUFFIX_TYPES[suffix]! : null;
}

export function isTargetType(v: unknown): v is TargetType {
  return typeof v === 'string' && (TARGET_TYPES as readonly string[]).includes(v);
}
