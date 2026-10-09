/**
 * The kernel replay corpus: one recorded delivery per JSONL line, as written by
 * `scripts/forensics/export-kernel-corpus.ts` (sanitized) or checked in as the
 * synthetic fixture under ./fixtures/.
 *
 * Every row keeps the fields the reducer reads and the fields its decisions
 * wrote, nothing else. Times are relative: `tUs` is microseconds since the
 * delivery row was created, so ordering and "same statement" (identical
 * timestamps, one `now()`) survive while absolute dates do not.
 */
import { readFileSync } from 'node:fs';

export const CORPUS_VERSION = 1;

type J = Record<string, unknown>;

export interface CorpusFact {
  id: string;
  kind: string;
  factKey: string;
  source: string;
  repoFullName: string | null;
  prNumber: number | null;
  payload: J;
  appliedTransitionId: string | null;
  tUs: number;
}

export interface CorpusTransition {
  id: string;
  fromVersion: number;
  toVersion: number;
  fromState: string | null;
  toState: string;
  command: string;
  idempotencyKey: string;
  actor: string;
  evidence: J;
  bypass: J | null;
  tUs: number;
}

export interface CorpusEffect {
  id: string;
  transitionId: string;
  kind: string;
  dedupeKey: string;
  payload: J;
  status: string;
  outcome: string | null;
  tUs: number;
}

export interface CorpusRound {
  id: string;
  round: number;
  headSha: string;
  kind: string;
  priorRound: number | null;
  scope: J | null;
  status: string;
  verdict: string | null;
  effectiveVerdict: string | null;
  confidence: number | null;
  failureCount: number;
  tUs: number;
}

export interface CorpusAttempt {
  id: string;
  family: string;
  attemptNo: number;
  mode: string;
  boundHeadSha: string | null;
  triggerReason: string | null;
  triggerFactId: string | null;
  taskId: string | null;
  trigger: string;
  reportedShas: string[];
  pushedHeadSha: string | null;
  status: string;
  outcome: string | null;
  maxAttempts: number;
  tUs: number;
  /**
   * When the row was last ended (`ended_at`), on the same clock as `tUs`; null
   * while it is open. Absent in a corpus exported before it was recorded. An
   * end at a transition's own `tUs` is that statement's write; any other is
   * out of band (an unbound worker end writes the row and no transition).
   */
  endedUs?: number | null;
}

export interface CorpusGateEvent {
  gate: string;
  surface: string;
  outcome: string;
  tUs: number;
}

export interface CorpusDelivery {
  v: typeof CORPUS_VERSION;
  delivery: {
    id: string;
    workspaceId: string;
    ownerTaskId: string;
    repoFullName: string | null;
    prNumber: number | null;
    baseRef: string | null;
    state: string;
    stateReason: string | null;
    version: number;
    currentHeadSha: string | null;
    currentRound: number;
    maxRounds: number;
    approvedHeads: string[];
    approvalBasis: string | null;
    compositionHeads: string[];
    authority: string;
  };
  /** How the delivery's work ended, for `--errors-first` and for reading a divergence. */
  outcome: {
    ownerTaskStatus: string | null;
    attemptTaskStatuses: string[];
    gateRefusals: number;
    /** worker_error_traces pattern slug → count, over the owner and attempt tasks. */
    errorPatterns: Record<string, number>;
  };
  facts: CorpusFact[];
  transitions: CorpusTransition[];
  effects: CorpusEffect[];
  rounds: CorpusRound[];
  attempts: CorpusAttempt[];
  gateEvents: CorpusGateEvent[];
}

/**
 * The checked-in fixture spells ids as `{id:N}` placeholders, never as UUIDs:
 * this repo is public and its no-prod-data gate refuses a UUID in any
 * non-test file, synthetic or not. `compactIds` writes them (each distinct
 * UUID gets the next ordinal, so the file is deterministic and readable) and
 * `parseCorpus` expands them back into UUIDs the database accepts.
 */
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const PLACEHOLDER_RE = /\{id:(\d+)\}/g;

export function compactIds(text: string): string {
  const seen = new Map<string, number>();
  return text.replace(UUID_RE, (m) => {
    const k = m.toLowerCase();
    if (!seen.has(k)) seen.set(k, seen.size + 1);
    return `{id:${seen.get(k)}}`;
  });
}

export function expandIds(text: string): string {
  return text.replace(PLACEHOLDER_RE, (_m, n: string) => `00000000-0000-4000-8000-${n.padStart(12, '0')}`);
}

export function parseCorpus(text: string, source = 'corpus'): CorpusDelivery[] {
  const out: CorpusDelivery[] = [];
  expandIds(text).split('\n').forEach((line, i) => {
    if (!line.trim()) return;
    let row: CorpusDelivery;
    try {
      row = JSON.parse(line) as CorpusDelivery;
    } catch (err) {
      throw new Error(`${source}:${i + 1}: not JSON (${(err as Error).message})`);
    }
    if (row.v !== CORPUS_VERSION) throw new Error(`${source}:${i + 1}: corpus version ${String(row.v)}, expected ${CORPUS_VERSION}`);
    if (!row.delivery?.id || !Array.isArray(row.transitions) || !Array.isArray(row.facts)) {
      throw new Error(`${source}:${i + 1}: missing delivery, transitions or facts`);
    }
    out.push(row);
  });
  return out;
}

export function readCorpus(path: string): CorpusDelivery[] {
  return parseCorpus(readFileSync(path, 'utf8'), path);
}
