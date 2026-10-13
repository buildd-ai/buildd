/**
 * The pure half of the service-status loader (docs/specs/team-service-status.md
 * section 9): the team's active root-cause records, the runner accounts they
 * name and the work they hit, turned into the input of the projection
 * (`service-status.ts`) and then into one viewer's statuses, banner and card.
 * No I/O, so the dev fixtures render it too; the reads are in
 * `service-status-loader.ts`.
 *
 * Who acts comes from structured fields of the runner account (section 8),
 * never from error text:
 *   - hosted (`managedRunner`): team admins replace the team key. Never a sign-in.
 *   - self-hosted subscription (`oauth`): the member who created it signs in on
 *     it; a shared host runner, or one whose creator is no longer on the team,
 *     falls to team admins. A sign-in the team still saved in buildd is the
 *     team admins' to remove.
 *   - self-hosted key (`api`): a team provider key is the team admins'; a key
 *     on the machine is the runner owner's (team admins when none).
 *   - platform and unknown causes: no one on the team.
 */
import type { RootCauseRecord } from '@buildd/shared';
import type { HomeAttentionItem } from './home-attention';
import {
  projectServiceStatus,
  statusAttentionItems,
  type ActionHolder,
  type AffectedWork,
  type Remedy,
  type RootCause,
  type ServiceStatus,
  type ServiceStatusViewer,
} from './service-status';

export type TeamRole = 'owner' | 'admin' | 'member';

export interface StatusRunner {
  id: string;
  name: string;
  authType: 'api' | 'oauth';
  managedRunner: boolean;
  hostRunner: boolean;
  createdByUserId: string | null;
  /** Used recently: counts toward "most of the team's work" and as a place to route work. */
  recentlyActive: boolean;
}

export interface StatusTask {
  id: string;
  title: string;
  workspaceId: string;
  status: string;
  createdByUserId: string | null;
  hasLiveRun: boolean;
}

export interface ServiceStatusFacts {
  teamId: string;
  /** Active root causes only (no verified restore). */
  records: readonly RootCauseRecord[];
  runners: readonly StatusRunner[];
  members: ReadonlyArray<{ userId: string; role: TeamRole }>;
  tasks: readonly StatusTask[];
  /** The team saved an agent provider key in Settings. */
  teamHasProviderKey: boolean;
  /** The team still has a subscription sign-in saved in buildd. */
  teamHasSavedSignIn: boolean;
  /** Team tasks created in the last day: the denominator for a platform cause's reach. */
  recentTaskCount: number;
}

/** Where each action happens. The runner page explains signing in on the machine; keys live on Models. */
export const RUNNERS_HREF = '/app/settings/runners';
export const SIGN_INS_HREF = '/app/settings/models#sign-ins';

const isAdminRole = (role: TeamRole | null | undefined) => role === 'owner' || role === 'admin';

/** Team-facing names for platform components. Never the internal rule name. */
const PLATFORM_LABELS: Record<string, string> = {
  stranded_gate: 'Pull request merging',
  lineage_multi_pr: 'Pull request merging',
  retry_fork: 'Task retries',
  path_overlap_stall: 'Task starts',
  provider_attribution_mismatch: 'Task starts',
};
const platformLabel = (component: string | null) => (component && PLATFORM_LABELS[component]) || 'Task starts';

const providerName = (p: string | null) => (p ? p.charAt(0).toUpperCase() + p.slice(1) : 'Provider');

/** Work that is still waiting: a task that later completed or was cancelled is not. */
const WAITING_DONE = new Set(['completed', 'cancelled']);

/**
 * Section 8, one row: who holds the fix for this runner cause, and what it is.
 * Hosted runners never yield a sign-in, whatever the record says.
 */
export function resolveHolder(
  record: Pick<RootCauseRecord, 'classification'>,
  runner: Pick<StatusRunner, 'authType' | 'managedRunner' | 'hostRunner' | 'createdByUserId'> | null,
  ctx: { memberIds: ReadonlySet<string>; teamHasProviderKey: boolean; teamHasSavedSignIn: boolean },
): { holder: ActionHolder; remedy: Remedy; href: string } {
  const admins: ActionHolder = { kind: 'team_admins' };
  if (!runner) return { holder: admins, remedy: record.classification === 'credential_expired' ? 'sign_in' : 'replace_team_key', href: record.classification === 'credential_expired' ? RUNNERS_HREF : SIGN_INS_HREF };
  if (runner.managedRunner) return { holder: admins, remedy: 'replace_team_key', href: SIGN_INS_HREF };
  const owner: ActionHolder | null = !runner.hostRunner && runner.createdByUserId && ctx.memberIds.has(runner.createdByUserId)
    ? { kind: 'person', userId: runner.createdByUserId }
    : null;
  if (record.classification === 'credential_expired') {
    if (ctx.teamHasSavedSignIn) return { holder: admins, remedy: 'remove_saved_sign_in', href: SIGN_INS_HREF };
    return { holder: owner ?? admins, remedy: 'sign_in', href: RUNNERS_HREF };
  }
  if (ctx.teamHasProviderKey) return { holder: admins, remedy: 'replace_team_key', href: SIGN_INS_HREF };
  return { holder: owner ?? admins, remedy: 'replace_machine_key', href: RUNNERS_HREF };
}

/**
 * Active records → projection input. Runner causes get their holder and
 * remedy; platform causes with the same team-facing name fold into one; every
 * unknown cause folds into one generic status, minus work a classified cause
 * already explains (one cause, one item).
 */
export function buildRootCauses(f: ServiceStatusFacts): RootCause[] {
  const runners = new Map(f.runners.map(r => [r.id, r]));
  const tasks = new Map(f.tasks.map(t => [t.id, t]));
  const memberIds = new Set(f.members.map(m => m.userId));
  const work = (ids: readonly string[]): AffectedWork[] => ids.flatMap(id => {
    const t = tasks.get(id);
    return t && !WAITING_DONE.has(t.status)
      ? [{ taskId: t.id, title: t.title, workspaceId: t.workspaceId, requesterUserId: t.createdByUserId, hasLiveRun: t.hasLiveRun }]
      : [];
  });

  const active = f.records.filter(r => r.teamId === f.teamId && !r.verifiedRestoredAt);
  const runnerCauses = active.filter(r => r.classification === 'credential_expired' || r.classification === 'api_key_rejected');
  const brokenRunnerIds = new Set(runnerCauses.flatMap(r => (r.capability.runnerId ? [r.capability.runnerId] : [])));
  const activeRunners = f.runners.filter(r => r.recentlyActive);
  const brokenActive = activeRunners.filter(r => brokenRunnerIds.has(r.id)).length;
  // Most of the team's work cannot start: the broken runners are most of those in use.
  const runnersWidespread = activeRunners.length > 0 && brokenActive * 2 > activeRunners.length;
  const alternateRunnerAvailable = activeRunners.some(r => !brokenRunnerIds.has(r.id));
  const base = { teamId: f.teamId, verifiedRestoredAt: null, nextUpdateAt: null, alternateRunnerAvailable };

  const out: RootCause[] = [];
  for (const r of runnerCauses) {
    const runner = r.capability.runnerId ? runners.get(r.capability.runnerId) ?? null : null;
    const { holder, remedy, href } = resolveHolder(r, runner, { memberIds, teamHasProviderKey: f.teamHasProviderKey, teamHasSavedSignIn: f.teamHasSavedSignIn });
    out.push({
      ...base, key: r.key, classification: r.classification, widespread: runnersWidespread,
      capability: {
        kind: 'runner', label: runner?.name ?? 'A runner', runnerId: r.capability.runnerId ?? undefined,
        provider: providerName(r.capability.provider), ownerUserId: runner?.createdByUserId ?? null,
        reconnectHref: href, holder, remedy,
      },
      affectedWork: work(r.affectedTaskIds), firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt,
    });
  }

  const explained = new Set(out.flatMap(c => c.affectedWork.map(w => w.taskId)));
  const platform = new Map<string, RootCause>();
  for (const r of active.filter(x => x.classification === 'platform_managed')) {
    const label = platformLabel(r.capability.component);
    const ids = r.affectedTaskIds.filter(id => !explained.has(id));
    const prior = platform.get(label);
    if (prior) {
      const seen = new Set(prior.affectedWork.map(w => w.taskId));
      prior.affectedWork.push(...work(ids).filter(w => !seen.has(w.taskId)));
      if (r.firstSeenAt < prior.firstSeenAt) prior.firstSeenAt = r.firstSeenAt;
      if (r.lastSeenAt > prior.lastSeenAt) prior.lastSeenAt = r.lastSeenAt;
      continue;
    }
    platform.set(label, {
      ...base, key: `platform:${label.toLowerCase().replace(/\s+/g, '-')}`, classification: 'platform_managed', widespread: false,
      capability: { kind: 'platform', label }, affectedWork: work(ids), firstSeenAt: r.firstSeenAt, lastSeenAt: r.lastSeenAt,
    });
  }
  for (const p of platform.values()) {
    // A platform cause is widespread when it holds most of the day's work (and enough of it to matter).
    p.widespread = p.affectedWork.length >= 3 && p.affectedWork.length * 2 > f.recentTaskCount;
    p.affectedWork.forEach(w => explained.add(w.taskId));
    out.push(p);
  }

  const unknown = active.filter(r => r.classification === 'unknown');
  if (unknown.length > 0) {
    const ids = [...new Set(unknown.flatMap(r => r.affectedTaskIds))].filter(id => !explained.has(id));
    // Every task it saw is explained by a known cause: it is that cause, not a second status.
    const everyTaskExplained = ids.length === 0 && unknown.every(r => r.affectedTaskIds.length > 0);
    if (!everyTaskExplained) {
      const seen = unknown.map(r => r.firstSeenAt).sort();
      const last = unknown.map(r => r.lastSeenAt).sort();
      out.push({
        ...base, key: 'unknown:team', classification: 'unknown', widespread: false,
        capability: { kind: 'platform', label: 'Task starts' }, affectedWork: work(ids),
        firstSeenAt: seen[0], lastSeenAt: last[last.length - 1],
      });
    }
  }
  return out;
}

export interface ServiceStatusView {
  /** The viewer's statuses, one per root cause: the quiet list on Health and task pages. */
  statuses: ServiceStatus[];
  /** At most one: shown on Home and Health while most of the team's work cannot start. */
  banner: ServiceStatus | null;
  /** The holder's cards; empty for everyone else. The only thing that adds to a count. */
  needsYou: HomeAttentionItem[];
  /** Tasks a classified active cause explains: they get no failed card of their own. */
  linkedTaskIds: ReadonlySet<string>;
}

export const EMPTY_SERVICE_STATUS: ServiceStatusView = { statuses: [], banner: null, needsYou: [], linkedTaskIds: new Set() };

/** The viewer's view of the team's causes. Pure. */
export function serviceStatusView(f: ServiceStatusFacts, userId: string): ServiceStatusView {
  const role = f.members.find(m => m.userId === userId)?.role ?? null;
  // Not on the team: nothing of the team's status, whatever the input holds.
  if (!role) return EMPTY_SERVICE_STATUS;
  const causes = buildRootCauses(f);
  const viewer: ServiceStatusViewer = {
    userId, teamId: f.teamId, isTeamAdmin: isAdminRole(role),
    // Runners this person may use: their own, and the team's shared host runners.
    usableRunnerIds: f.runners.filter(r => r.createdByUserId === userId || r.hostRunner).map(r => r.id),
  };
  const statuses = projectServiceStatus(causes, viewer);
  return {
    statuses,
    banner: statuses.find(s => s.attention === 'banner') ?? null,
    needsYou: statusAttentionItems(statuses),
    linkedTaskIds: new Set(causes.filter(c => c.classification !== 'unknown').flatMap(c => c.affectedWork.map(w => w.taskId))),
  };
}
