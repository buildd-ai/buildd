// Read shapes of the /v1 inspection routes. The lookup shapes the repair
// floor consumes (`GET /v1/intents`) live in @buildd/dispatch-contract and
// are re-exported here; the rest are local to the Worker.

import type { IntentState, IntentSummary, RouteStep } from '@buildd/dispatch-contract';
import type { TargetOptions, TargetType } from './adapters/types';

export {
  INTENT_STATES,
  TERMINAL_STATES,
  type IntentState,
  type IntentSummary,
  type IntentsLookupResponse,
} from '@buildd/dispatch-contract';

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
