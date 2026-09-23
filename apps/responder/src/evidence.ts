/**
 * Local, embedded state: an append-only JSONL evidence log plus one small
 * state file, under a configurable directory.
 *
 * ── Why not the production database ─────────────────────────────────────────
 * Because that is shared fate, and shared fate is the whole defect this app
 * addresses. A responder whose memory of "have I already paged for this" lives
 * in the database cannot remember anything during a database incident — which
 * is one of the incidents it exists to report. It would go quiet at exactly
 * the moment it is needed, and it would be trusted while doing so.
 *
 * ── Why append-only ─────────────────────────────────────────────────────────
 * The design requires a durable record with the triggering evidence for every
 * notification *and* every suppression decision. "We decided not to page you"
 * is the harder half: it is invisible by nature, and an operator asking "why
 * did nobody tell me" needs to find the line that says a page was withheld and
 * until when. Append-only means no cycle can overwrite the answer, and one
 * object per line means a torn write at process death loses one record rather
 * than the file.
 *
 * ── Why the state file is separate, and rewritten ───────────────────────────
 * The renotify windows and the claim-sample ring are *current values*, not
 * history: replaying a day of JSONL to learn the last notify time would make
 * every cycle O(log size). So they live in `state.json`, written atomically
 * (temp file + rename) so a crash mid-write cannot leave a half-parsed file
 * that disarms the responder on restart. And when it is unparseable anyway, it
 * reads as empty rather than throwing — a responder that refuses to start
 * because of its own bookkeeping is worse than one that re-pages once.
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { ClaimSample, Verdict } from './types';

export interface NotifyWindow {
  firstNotifiedAt: string;
  lastNotifiedAt: string;
  /** The onset that was paged for, so a renotify can say how long it has run. */
  onsetAt: string | null;
  pageCount: number;
}

export interface ResponderState {
  /** Per condition key. Absence means "not currently paged". */
  notified: Record<string, NotifyWindow>;
  /** Claim-probe samples inside the retention window, oldest first. */
  samples: ClaimSample[];
  /**
   * The first sample ever recorded, and deliberately NOT pruned with the ring.
   * It is the only way a detector can distinguish "just started, no data yet"
   * from "has been watching for hours and is recording nothing" — a cold start
   * from a broken probe. Collapsing those two is how a monitor reports health
   * while blind.
   */
  samplingSince: string | null;
}

export const EMPTY_STATE: ResponderState = Object.freeze({
  notified: {},
  samples: [],
  samplingSince: null,
}) as ResponderState;

export type EvidenceRecord =
  /** One line per cycle: the full verdict series, for forensics after the fact. */
  | {
      kind: 'cycle';
      at: string;
      verdicts: Verdict[];
      inputs: Record<string, unknown>;
    }
  /** A page went out. */
  | {
      kind: 'notified';
      at: string;
      conditionKey: string;
      detector: string;
      trigger: 'onset' | 'renotify';
      onsetAt: string | null;
      summary: string;
      narrative: 'included' | 'unavailable' | 'no-credential';
      facts: Record<string, unknown>;
    }
  /** A page was deliberately withheld. Never inferable from silence. */
  | {
      kind: 'suppressed';
      at: string;
      conditionKey: string;
      reason: 'within_renotify_window';
      lastNotifiedAt: string;
      nextEligibleAt: string;
      onsetAt: string | null;
      summary: string;
    }
  /** The condition went away; the next onset pages immediately. */
  | { kind: 'cleared'; at: string; conditionKey: string; pagedSince: string | null }
  /** The notification transport itself failed. The one thing nothing else can catch. */
  | { kind: 'notify_failed'; at: string; conditionKey: string; error: string }
  /** Not enough data yet. Recorded, never paged. */
  | { kind: 'warming'; at: string; conditionKey: string; summary: string };

const STATE_FILE = 'state.json';

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Evidence files rotate by UTC day. */
export function evidenceFileName(at: string): string {
  return `evidence-${at.slice(0, 10)}.jsonl`;
}

export function appendEvidence(dir: string, record: EvidenceRecord): void {
  ensureDir(dir);
  appendFileSync(join(dir, evidenceFileName(record.at)), JSON.stringify(record) + '\n', 'utf8');
}

export function readEvidence(dir: string, fileName: string): EvidenceRecord[] {
  const path = join(dir, fileName);
  if (!existsSync(path)) return [];
  const out: EvidenceRecord[] = [];
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as EvidenceRecord);
    } catch {
      // A torn final line from a process that died mid-write. Skipping it is
      // the point of one-object-per-line.
    }
  }
  return out;
}

export function loadState(dir: string): ResponderState {
  const path = join(dir, STATE_FILE);
  if (!existsSync(path)) return EMPTY_STATE;
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ResponderState>;
    return {
      notified: parsed.notified ?? {},
      samples: parsed.samples ?? [],
      samplingSince: parsed.samplingSince ?? null,
    };
  } catch {
    return EMPTY_STATE;
  }
}

export function saveState(dir: string, state: ResponderState): void {
  ensureDir(dir);
  const target = join(dir, STATE_FILE);
  const temp = `${target}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, JSON.stringify(state), 'utf8');
    renameSync(temp, target);
  } catch (err) {
    // Clean up rather than leaving a stray temp file that looks like state.
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      /* nothing useful to do */
    }
    throw err;
  }
}

export function pruneSamples(
  samples: readonly ClaimSample[],
  now: number,
  retentionHours: number,
): ClaimSample[] {
  const cutoff = now - retentionHours * 3_600_000;
  return samples
    .filter(s => Date.parse(s.at) >= cutoff)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Returns a NEW state. Transitions are values, not mutations, so a crash part
 * way through a cycle cannot leave a half-updated object to be written out.
 */
export function recordSample(
  state: ResponderState,
  sample: ClaimSample,
  now: number,
  retentionHours: number,
): ResponderState {
  return {
    ...state,
    samples: pruneSamples([...state.samples, sample], now, retentionHours),
    samplingSince: state.samplingSince ?? sample.at,
  };
}
