/**
 * A claim `c` asked for and the server refused, in a short sentence (from the
 * owner: the status line showed `Claim refused: Server rejected claim for task
 * "<the whole title>" — reason: race_lost`, cut off before the reason).
 *
 * Two halves of one contract: the runner's socket adds the refusal's fields to
 * its answer (`claimRefusalBody`), and top puts them in words
 * (`claimRefusalWords`). An older runner sends only `error`; its prose still
 * reads without the title and the raw code.
 */
import { TERMS } from '@buildd/shared';
import { EXCLUSION_WORDS } from './state';

export interface ClaimRefusalBody {
  error: string;
  /** The claim's diagnostic reason: race_lost, no_pending_tasks, all_candidates_deferred... */
  claimReason?: string;
  /** The gate that excluded this task, when the server named one. */
  exclusion?: string;
  /** The server's HTTP status when it refused the request itself (429 at the account limit). */
  serverStatus?: number;
  /** The refusal body's machine code, e.g. max_concurrent_workers. */
  code?: string;
  limit?: number;
  current?: number;
}

/** The fields of a claim error thrown by claimAndStart (workers.ts) or the API client (ServerRefusalError). */
export function claimRefusalBody(err: any): ClaimRefusalBody {
  const body: ClaimRefusalBody = { error: (err?.message as string) || 'Failed to claim' };
  if (typeof err?.claimReason === 'string') body.claimReason = err.claimReason;
  if (typeof err?.claimTaskExclusionCode === 'string') body.exclusion = err.claimTaskExclusionCode;
  if (typeof err?.status === 'number') body.serverStatus = err.status;
  if (typeof err?.raw === 'string') {
    try {
      const raw = JSON.parse(err.raw);
      if (typeof raw?.code === 'string') body.code = raw.code;
      if (typeof raw?.limit === 'number') body.limit = raw.limit;
      if (typeof raw?.current === 'number') body.current = raw.current;
    } catch { /* not JSON: error carries the prose */ }
  }
  return body;
}

const REASON_WORDS: Record<string, string> = {
  race_lost: 'another runner took it first',
  no_pending_tasks: 'it is no longer waiting (taken or finished)',
  no_slots: "the account's worker limit is reached",
  budget_exhausted: 'a plan or rate limit holds it',
  context_paused: 'claims are paused after repeated failures',
  runner_held: `this runner is ${TERMS['runner.paused'].short}`,
};

const EXCLUSION_OVERRIDES: Record<string, string> = {
  mission_local: 'its mission is managed from a local session',
  task_reserved: 'a local session reserved it',
};

/** Why the claim was refused, in words, without the task's title. */
export function claimRefusalWords(body: unknown, status: number): string {
  const b = (body && typeof body === 'object' ? body : {}) as Partial<ClaimRefusalBody>;
  if (b.code === 'max_concurrent_workers' || b.serverStatus === 429) {
    if (typeof b.limit === 'number') {
      const busy = typeof b.current === 'number' ? b.current : b.limit;
      return `your account allows ${b.limit} at once and ${busy === b.limit ? `all ${busy}` : busy} are busy`;
    }
    return "the account's worker limit is reached";
  }
  if (b.exclusion) return EXCLUSION_OVERRIDES[b.exclusion] ?? EXCLUSION_WORDS[b.exclusion] ?? b.exclusion.replace(/_/g, ' ');
  if (b.claimReason && REASON_WORDS[b.claimReason]) return REASON_WORDS[b.claimReason];
  const text = typeof body === 'string' ? body : typeof b.error === 'string' ? b.error : '';
  // An older runner's prose: drop `Server rejected claim for task "<title>" — `.
  const m = text.match(/^Server rejected claim for task ".*" [—-] (?:reason: )?(.+)$/s);
  if (m) {
    const rest = m[1].trim();
    return REASON_WORDS[rest] ?? rest.replace(/_/g, ' ');
  }
  if (/temporarily paused/.test(text)) return 'claims pause briefly after a rate limit; try again shortly';
  if (text.trim()) return text.trim().replace(/\.$/, '');
  return `HTTP ${status}`;
}
