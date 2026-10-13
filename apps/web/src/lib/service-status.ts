/**
 * Team service status (docs/specs/team-service-status.md). Pure: raw failure
 * signals in, one correlated, viewer-scoped status per root cause out. No I/O,
 * no model call, and nothing here triggers a retry, a resume or a provider
 * change. It reads no operator role: the same person gets the same projection
 * whether or not they also run the platform.
 */
import type { HomeAttentionItem } from './home-attention';

export type RootCauseClass = 'credential_expired' | 'api_key_rejected' | 'platform_managed' | 'unknown';
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

/**
 * Who holds the fix for a runner cause (spec section 8): one person, the team
 * admins as a role, or no one. Exactly one per cause.
 */
export type ActionHolder = { kind: 'person'; userId: string } | { kind: 'team_admins' } | { kind: 'none' };

/**
 * What the holder does: sign in on the runner machine, replace the team's
 * provider key in Settings, replace the key set on the machine, or remove a
 * sign-in still saved in buildd and sign in on the runner instead.
 */
export type Remedy = 'sign_in' | 'replace_team_key' | 'replace_machine_key' | 'remove_saved_sign_in';

export interface RootCause {
  key: string;
  teamId: string;
  classification: RootCauseClass;
  capability: {
    kind: 'runner' | 'platform'; label: string; runnerId?: string; provider?: string; ownerUserId?: string | null;
    /** Where the holder's action happens; null when no real path exists. */
    reconnectHref?: string | null;
    /** Absent: the owner when one is recorded, else team admins. */
    holder?: ActionHolder;
    /** Absent: `sign_in`. */
    remedy?: Remedy;
  };
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
  | { kind: 'replace_key'; label: string; href: string }
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

const isRunnerCause = (c: RootCauseClass) => c === 'credential_expired' || c === 'api_key_rejected';

/** The holder a cause names, with the default for records built before holders existed. */
export function holderOf(r: RootCause): ActionHolder {
  if (!isRunnerCause(r.classification)) return { kind: 'none' };
  if (r.capability.holder) return r.capability.holder;
  return r.capability.ownerUserId ? { kind: 'person', userId: r.capability.ownerUserId } : { kind: 'team_admins' };
}

const holds = (h: ActionHolder, v: ServiceStatusViewer) =>
  h.kind === 'person' ? h.userId === v.userId : h.kind === 'team_admins' && v.isTeamAdmin;

/** What the holder reads and does, by remedy. */
function holderCopy(remedy: Remedy, label: string, provider: string, href: string | null): { title: string; condition: string; action: StatusAction | null } {
  switch (remedy) {
    case 'replace_team_key':
      return { title: 'Runner key needs replacing', condition: `${label} could not use the team's ${provider} key`, action: href ? { kind: 'replace_key', label: 'Replace the key in Settings', href } : null };
    case 'replace_machine_key':
      return { title: 'Runner key needs replacing', condition: `${label} could not use its ${provider} key`, action: href ? { kind: 'replace_key', label: `Replace the key on ${label}`, href } : null };
    case 'remove_saved_sign_in':
      return { title: 'Runner needs sign-in', condition: `${label} (${provider}) uses a sign-in saved in buildd that no longer works`, action: href ? { kind: 'reconnect', label: 'Remove the saved sign-in', href } : null };
    default:
      return { title: 'Runner needs sign-in', condition: `${label} (${provider}) needs sign-in`, action: href ? { kind: 'reconnect', label: `Sign in on ${label}`, href } : null };
  }
}

/**
 * One status per root cause for this viewer; the field set depends on who is
 * asking. A runner cause has one action holder (`holderOf`): they get the
 * action and the only Needs You card. Team admins who do not hold it get the
 * coordination view (who owns it, and moving the work to another runner) as a
 * quiet status; members get the waiting line on their own work.
 */
export function projectServiceStatus(records: readonly RootCause[], viewer: ServiceStatusViewer): ServiceStatus[] {
  const out: ServiceStatus[] = [];
  for (const r of records) {
    if (r.teamId !== viewer.teamId || r.verifiedRestoredAt) continue;
    const cap = r.capability;
    const holder = holderOf(r);
    const isHolder = holds(holder, viewer);
    const scope: ServiceStatus['scope'] = isHolder && holder.kind === 'person' ? 'credential_owner' : viewer.isTeamAdmin ? 'team_admin' : 'member';
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

    if (isRunnerCause(r.classification)) {
      state = 'waiting_on_person';
      const remedy: Remedy = cap.remedy ?? (r.classification === 'api_key_rejected' ? 'replace_team_key' : 'sign_in');
      const signIn = remedy === 'sign_in' || remedy === 'remove_saved_sign_in';
      if (isHolder) {
        ({ title, condition, action } = holderCopy(remedy, cap.label, cap.provider ?? 'provider', cap.reconnectHref ?? null));
        if (action) attention = 'needs_you';
      } else if (scope === 'team_admin') {
        title = holder.kind === 'person'
          ? `${cap.label} is waiting for its owner to ${signIn ? 'sign in' : 'replace its key'}`
          : `${cap.label} is waiting for ${signIn ? 'sign-in' : 'a new key'}`;
        condition = title;
        // Routing is the admin's to decide, but it is not the fix: quiet, never a card.
        if (r.alternateRunnerAvailable && work.length > 0) action = { kind: 'route_work', label: 'Move work to another runner', href: '/app/settings/runners' };
      } else {
        title = signIn ? 'Waiting for runner sign-in' : 'Waiting for a runner key';
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
      ...(scope === 'team_admin' && holder.kind === 'person' ? { ownerRef: { userId: holder.userId } } : {}),
    });
  }
  return out;
}

/** Needs You cards: only statuses where the viewer holds a concrete action. */
export function statusAttentionItems(statuses: readonly ServiceStatus[]): HomeAttentionItem[] {
  const items: HomeAttentionItem[] = [];
  for (const s of statuses) {
    // Only the holder's fix is a card; moving work elsewhere stays on the quiet list.
    if (s.attention !== 'needs_you' || !s.action || s.action.kind === 'route_work') continue;
    const reconnect = s.action.kind === 'reconnect';
    items.push({
      key: `service-status:${s.key}`, kind: 'queue', label: reconnect ? 'sign-in' : 'runner key',
      tone: 'warning', title: s.title, sentence: `${s.condition}. ${plural(s.work.length, 'task')} waiting.`, meta: s.capability, href: s.action.href,
      actionType: reconnect ? 'reconnect' : 'fix', primary: { label: s.action.label, href: s.action.href }, owner: 'human',
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
