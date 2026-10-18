/**
 * A claim log entry in words, for the local debug page's Recent Claims rows
 * (spec c7410e76 R-28, AC-13). Reuses the wording `buildd top` already has for
 * the same server answers (top/state.ts), so the two never disagree.
 */
import { TERMS } from '@buildd/shared';
import type { ClaimLogEntry } from './session-logger';
import { DEFERRAL_WORDS, EXCLUSION_WORDS, MOVED_CODES, localLiftTime, wallWord } from './top/state';

/** A gate the server did not name (terms catalog `wait.unknown`). */
const UNKNOWN = TERMS['wait.unknown'].word;
const USAGE_LIMIT = TERMS['wait.usage_limit'].short;

const PROVIDER_NAME: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

const REASON_WORDS: Record<string, string> = {
  no_slots: 'every slot is busy',
  no_workspaces: 'no workspace to claim from',
  no_pending_tasks: 'nothing waiting',
  capability_mismatch: 'waiting work needs something this runner lacks',
  race_lost: 'another runner took it',
  all_candidates_deferred: 'nothing can start yet',
  deps_blocked: 'waits on a dependency',
  repo_busy: 'waits for work on the same files',
  path_overlap_blocked: 'waits for work on the same files',
  budget_exhausted: USAGE_LIMIT,
  budget_exhausted_partial: `${USAGE_LIMIT} for one provider`,
  context_paused: 'paused after repeated failures',
  rate_limited: 'claimed too recently, retry soon',
};

function cap(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

function wallPhrase(w: NonNullable<ClaimLogEntry['walls']>[number], now: number): string {
  const who = PROVIDER_NAME[w.backend] ?? cap(w.backend);
  const t = w.resetsAt ? Date.parse(w.resetsAt) : NaN;
  const until = !Number.isNaN(t) && t > now ? ` until ${localLiftTime(w.resetsAt as string, now)}` : '';
  return `${who} ${wallWord(w.kind)}${until}`;
}

export function claimEntryWords(e: ClaimLogEntry, now: number = Date.now()): string {
  if (e.event === 'claim_success') {
    return `claimed ${e.workersClaimed}/${e.slotsRequested}${e.taskId ? ` (${e.taskId.slice(0, 8)})` : ''}`;
  }
  if (e.event === 'claim_idle') {
    const n = e.idlePolls ?? 0;
    return `nothing waiting: ${n} poll${n === 1 ? '' : 's'}${e.idleSince ? ` since ${new Date(e.idleSince).toLocaleTimeString()}` : ''}`;
  }
  if (e.event === 'claim_rejected') {
    if (e.status === 0) return 'no answer from the server; any workers it started are released';
    const why = e.reason ? `: ${e.reason}` : '';
    return `refused${e.status ? ` (${e.status})` : ''}${why}`;
  }
  if (e.event === 'claim_attempt') return 'asking the server for work';

  // claim_empty: a plan or rate limit first, then the gate that stopped the task, then the reason.
  if (e.walls && e.walls.length > 0) return `waiting: ${e.walls.map(w => wallPhrase(w, now)).join(', ')}`;
  const code = e.taskExclusion;
  if (code && !MOVED_CODES.has(code)) {
    if (code === 'runner_cooldown') return 'waiting: cooldown after a failure';
    if (code === 'budget_paused') return USAGE_LIMIT;
    const until = e.until ? Date.parse(e.until) : NaN;
    const words = EXCLUSION_WORDS[code] ?? DEFERRAL_WORDS[code];
    if (!words) return UNKNOWN;
    return !Number.isNaN(until) && until > now ? `waiting: ${words}, until ${localLiftTime(e.until as string, now)}` : `waiting: ${words}`;
  }
  if (e.diagnosticReason === 'all_candidates_deferred') {
    const keys = Object.entries(e.deferrals ?? {}).filter(([, n]) => typeof n === 'number' && n > 0).map(([k]) => k);
    if (keys.length === 1) return DEFERRAL_WORDS[keys[0]] ? `waiting: ${DEFERRAL_WORDS[keys[0]]}` : UNKNOWN;
  }
  if (e.diagnosticReason) return REASON_WORDS[e.diagnosticReason] ?? UNKNOWN;
  return 'nothing claimed';
}
