/**
 * Team service status (docs/specs/team-service-status.md). Pure: raw failure
 * signals in, one correlated, viewer-scoped status per root cause out. No I/O,
 * no model call, and nothing here triggers a retry, a resume or a provider
 * change. It reads no operator role: the same person gets the same projection
 * whether or not they also run the platform.
 */
import type { HomeAttentionItem } from './home-attention';

export type RootCauseClass = 'credential_expired' | 'platform_managed' | 'unknown';
export type RecoveryState = 'investigating' | 'waiting_on_person' | 'recovering' | 'restored';
export type StatusAttention = 'needs_you' | 'banner' | 'quiet';

export interface AffectedWork {
  taskId: string;
  title: string;
  workspaceId: string;
  /** The person whose work it is; scopes what a member may see. */
  requesterUserId: string | null;
  /** A run is still live: resuming it again would duplicate execution. */
  hasLiveRun: boolean;
}

export interface ExpiredRunnerSignal {
  runnerId: string;
  runnerName: string;
  provider: string;
  ownerUserId: string | null;
  /** A real reconnect path (the owner's own runner sign-in); null when none exists. */
  reconnectHref: string | null;
  work: AffectedWork[];
  seenAt: string;
}

export interface RawFailureSignals {
  teamId: string;
  expiredRunnerOauth: ExpiredRunnerSignal[];
  /** Operator-side numbers; consumed for correlation, never projected. */
  failureRateAlert?: { runnerId?: string; provider?: string; rate: number; baseline: number; seenAt: string } | null;
  sentinelTasks?: Array<{ taskId: string; title: string; runnerId?: string; provider?: string; seenAt: string }>;
  platformManaged?: Array<{ key: string; label: string; work: AffectedWork[]; seenAt: string }>;
  /** Another runner could take the waiting work; makes the admin routing decision real. */
  alternateRunnerAvailable?: boolean;
  /** Most of the team's work cannot start. */
  widespread?: boolean;
  /** A scheduled retry or known window; absent unless data backs it. */
  nextUpdateAt?: string | null;
}

export interface RootCause {
  key: string;
  teamId: string;
  classification: RootCauseClass;
  capability: { kind: 'runner' | 'platform'; label: string; runnerId?: string; provider?: string; ownerUserId?: string | null; reconnectHref?: string | null };
  affectedWork: AffectedWork[];
  firstSeenAt: string;
  lastSeenAt: string;
  verifiedRestoredAt: string | null;
  alternateRunnerAvailable: boolean;
  widespread: boolean;
  nextUpdateAt: string | null;
}

const UNKNOWN_KEY = 'unknown:platform';

/** Folds every signal about one cause into one record per root cause. */
export function correlateSignals(s: RawFailureSignals): RootCause[] {
  const common = { teamId: s.teamId, verifiedRestoredAt: null, alternateRunnerAvailable: !!s.alternateRunnerAvailable, widespread: !!s.widespread, nextUpdateAt: s.nextUpdateAt ?? null };
  const byRunner = new Map<string, RootCause>();
  const records: RootCause[] = [];
  for (const e of s.expiredRunnerOauth) {
    const prior = byRunner.get(e.runnerId);
    if (prior) {
      const seen = new Set(prior.affectedWork.map(w => w.taskId));
      prior.affectedWork.push(...e.work.filter(w => !seen.has(w.taskId)));
      prior.lastSeenAt = e.seenAt > prior.lastSeenAt ? e.seenAt : prior.lastSeenAt;
      continue;
    }
    const rec: RootCause = {
      ...common, key: `cred:${e.runnerId}`, classification: 'credential_expired',
      capability: { kind: 'runner', label: e.runnerName, runnerId: e.runnerId, provider: e.provider, ownerUserId: e.ownerUserId, reconnectHref: e.reconnectHref },
      affectedWork: [...e.work], firstSeenAt: e.seenAt, lastSeenAt: e.seenAt,
    };
    byRunner.set(e.runnerId, rec);
    records.push(rec);
  }
  for (const p of s.platformManaged ?? []) {
    records.push({ ...common, key: `platform:${p.key}`, classification: 'platform_managed', capability: { kind: 'platform', label: p.label }, affectedWork: [...p.work], firstSeenAt: p.seenAt, lastSeenAt: p.seenAt });
  }
  // An alert or sentinel task is evidence for a cause that already exists when it names the same
  // runner or provider; otherwise it is one generic status, never a guessed specific cause.
  const explained = (x: { runnerId?: string; provider?: string }) =>
    records.some(r => r.classification === 'credential_expired' && ((x.runnerId && r.capability.runnerId === x.runnerId) || (!x.runnerId && x.provider && r.capability.provider === x.provider)));
  const loose = [s.failureRateAlert, ...(s.sentinelTasks ?? [])].filter((x): x is NonNullable<typeof x> => !!x && !explained(x));
  if (loose.length > 0) {
    const seen = loose.map(x => x.seenAt).sort();
    records.push({ ...common, key: UNKNOWN_KEY, classification: 'unknown', capability: { kind: 'platform', label: 'Task starts' }, affectedWork: [], firstSeenAt: seen[0], lastSeenAt: seen[seen.length - 1] });
  }
  return records;
}

/** A capability check on the affected runner/provider. Only a passing one restores. */
export function applyCapabilityCheck(r: RootCause, check: { ok: boolean; checkedAt: string }): RootCause {
  return check.ok ? { ...r, verifiedRestoredAt: check.checkedAt } : r;
}

export interface ServiceStatusViewer {
  userId: string;
  teamId: string;
  /** Holds manage_team_settings. */
  isTeamAdmin: boolean;
  /** Runners this person may use. */
  usableRunnerIds: readonly string[];
}

export type StatusAction =
  | { kind: 'reconnect'; label: string; href: string }
  | { kind: 'route_work'; label: string; href: string };

export interface ServiceStatus {
  key: string;
  scope: 'credential_owner' | 'team_admin' | 'member';
  title: string;
  capability: string;
  condition: string;
  effect: string;
  state: RecoveryState;
  nextUpdateAt?: string;
  work: Array<{ taskId: string; title: string; href: string }>;
  action: StatusAction | null;
  attention: StatusAttention;
  /** Team admins only. */
  ownerRef?: { userId: string };
}

const GENERIC = 'Something is slowing work; we are looking at it';
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** One status per root cause for this viewer; the field set depends on who is asking. */
export function projectServiceStatus(records: readonly RootCause[], viewer: ServiceStatusViewer): ServiceStatus[] {
  const out: ServiceStatus[] = [];
  for (const r of records) {
    if (r.teamId !== viewer.teamId || r.verifiedRestoredAt) continue;
    const cap = r.capability;
    const isOwner = r.classification === 'credential_expired' && !!cap.ownerUserId && cap.ownerUserId === viewer.userId;
    const scope: ServiceStatus['scope'] = isOwner ? 'credential_owner' : viewer.isTeamAdmin ? 'team_admin' : 'member';
    const seesAll = scope !== 'member';
    const work = seesAll ? r.affectedWork : r.affectedWork.filter(w => w.requesterUserId === viewer.userId);
    const usesRunner = !!cap.runnerId && viewer.usableRunnerIds.includes(cap.runnerId);
    if (!seesAll && work.length === 0 && !usesRunner) continue;

    const effect = work.length === 0 ? 'No work affected' : `${plural(work.length, 'task')} ${work.length === 1 ? 'is' : 'are'} waiting`;
    let title = GENERIC;
    let condition = GENERIC;
    let state: RecoveryState = 'investigating';
    let action: StatusAction | null = null;
    let attention: StatusAttention = r.widespread ? 'banner' : 'quiet';

    if (r.classification === 'credential_expired') {
      state = 'waiting_on_person';
      if (scope === 'credential_owner') {
        title = 'Runner needs sign-in';
        condition = `${cap.label} (${cap.provider}) needs sign-in`;
        if (cap.reconnectHref) {
          action = { kind: 'reconnect', label: `Sign in on ${cap.label}`, href: cap.reconnectHref };
          attention = 'needs_you';
        }
      } else if (scope === 'team_admin') {
        title = `${cap.label} is waiting for its owner to sign in`;
        condition = title;
        if (r.alternateRunnerAvailable && work.length > 0) {
          action = { kind: 'route_work', label: 'Move work to another runner', href: '/app/settings/runners' };
          attention = 'needs_you';
        }
      } else {
        title = 'Waiting for runner sign-in';
        condition = title;
      }
    } else if (r.classification === 'platform_managed') {
      title = `${cap.label} is slower than usual`;
      condition = title;
    }

    out.push({
      key: `${r.teamId}:${r.key}:${scope}`,
      scope, title, capability: cap.label, condition, effect, state,
      ...(r.nextUpdateAt ? { nextUpdateAt: r.nextUpdateAt } : {}),
      work: work.map(w => ({ taskId: w.taskId, title: w.title, href: `/app/tasks/${w.taskId}` })),
      action, attention,
      ...(scope === 'team_admin' && cap.ownerUserId ? { ownerRef: { userId: cap.ownerUserId } } : {}),
    });
  }
  return out;
}

/** Needs You cards: only statuses where the viewer holds a concrete action. */
export function statusAttentionItems(statuses: readonly ServiceStatus[]): HomeAttentionItem[] {
  const items: HomeAttentionItem[] = [];
  for (const s of statuses) {
    if (s.attention !== 'needs_you' || !s.action) continue;
    const reconnect = s.action.kind === 'reconnect';
    const sentence = reconnect
      ? `${s.condition}. ${plural(s.work.length, 'task')} waiting.`
      : `${s.condition}. ${plural(s.work.length, 'task')} waiting; you can move the work to another runner.`;
    items.push({
      key: `service-status:${s.key}`, kind: 'queue', label: reconnect ? 'runner needs sign-in' : 'service status',
      tone: 'warning', title: s.title, sentence, meta: s.capability, href: s.action.href,
      actionType: reconnect ? 'reconnect' : 'decide', primary: { label: s.action.label, href: s.action.href }, owner: 'human',
    });
  }
  return items;
}

export interface StatusLedgerEntry { key: string; state: 'active' | 'cleared'; notifiedAt: string; clearedAt?: string }
export interface ResumeRequest { taskId: string; runnerId: string; providerFallback: 'none' }

/**
 * Compares what is observed with what the team was already told. Notifies only
 * for a cause that was never active; a cleared cause that repeats reopens
 * silently. The resume list is a request for the existing workflow authority:
 * waiting work only, on the same runner, never an API-key or other-provider move.
 */
export function reconcileServiceStatus({ ledger, records, now }: { ledger: readonly StatusLedgerEntry[]; records: readonly RootCause[]; now: string }) {
  const next = new Map(ledger.map(e => [e.key, { ...e }]));
  const notify: string[] = [];
  const cleared: string[] = [];
  const resume: ResumeRequest[] = [];
  for (const r of records) {
    const entry = next.get(r.key);
    if (r.verifiedRestoredAt) {
      if (entry?.state !== 'active') continue;
      entry.state = 'cleared';
      entry.clearedAt = now;
      cleared.push(r.key);
      if (r.classification === 'credential_expired' && r.capability.runnerId) {
        for (const w of r.affectedWork) if (!w.hasLiveRun) resume.push({ taskId: w.taskId, runnerId: r.capability.runnerId, providerFallback: 'none' });
      }
    } else if (!entry) {
      next.set(r.key, { key: r.key, state: 'active', notifiedAt: now });
      notify.push(r.key);
    } else if (entry.state === 'cleared') {
      entry.state = 'active';
      delete entry.clearedAt;
    }
  }
  return { ledger: [...next.values()], notify, cleared, resume };
}
