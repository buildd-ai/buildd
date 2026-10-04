// Read shapes of the /v1 inspection routes. Local to the Worker for now; move
// them into @buildd/dispatch-contract when a producer starts consuming them
// (the repair floor's `GET /v1/intents`).

import type { RouteStep } from '@buildd/dispatch-contract';
import type { TargetOptions, TargetType } from './adapters/types';

export const INTENT_STATES = ['queued', 'attempting', 'delivered', 'failed', 'merged', 'expired', 'skipped'] as const;
export type IntentState = (typeof INTENT_STATES)[number];
export const TERMINAL_STATES: readonly IntentState[] = ['delivered', 'failed', 'merged', 'expired', 'skipped'];

export interface IntentSummary {
  id: string;
  state: IntentState;
  /** Attempts made so far. */
  attempt: number;
  mergedInto?: string;
}

/** `GET /v1/intents?scope=&ids=`. */
export interface IntentsLookupResponse {
  known: IntentSummary[];
  unknown: string[];
}

export interface TargetActivity {
  target: string;
  attempts: number;
  lastOutcome: string;
  lastDetail?: string;
  lastAt: string;
}

/** `GET /v1/intents/:id?scope=`. No payload, no grant. */
export interface IntentDetail extends IntentSummary {
  kind: string;
  subject?: string;
  dedupeKey?: string;
  labels?: { cause: string; causes: string[] };
  steps: RouteStep[];
  /** Index (among `first` steps) the next attempt starts at. */
  step: number;
  notBefore?: string;
  expiresAt?: string;
  nextDue?: string;
  lastError?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  targets: TargetActivity[];
}

/** `GET /v1/scopes/:scope`. */
export interface ScopeCounts {
  scope: string | null;
  paused: boolean;
  intents: Record<IntentState, number>;
  pendingReceipts: number;
  nextDue?: string;
  targets: number;
}

export interface TargetRecord {
  id: string;
  type: TargetType;
  options: TargetOptions;
}
