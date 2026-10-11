/**
 * What the platform owner may see of a team's work through /api/admin/*.
 *
 * Full detail only for the teams the owner is a member of ("own" teams). Every
 * other team is aggregate-only: it is named by a stable pseudonym ("Team
 * 3f9a1c"), and nothing it wrote reaches the response — no task, mission or
 * experiment titles, PR numbers or URLs, branch or repo names, error text or
 * failure signatures. Counts, costs, durations, rates and platform-authored
 * labels (exit causes, gate names, models, tiers) still include it.
 *
 * Every admin read goes through one of the views below. A drilldown (top
 * tasks, band tasks, failure examples) lists own-team rows only; the other
 * teams contribute to its totals. Where a report pools free text across
 * workspaces (failure signatures, gate reasons), the text comes from a second
 * read over own workspaces alone, since a pooled row cannot say whose it is.
 */
import { createHash } from 'node:crypto';
import type { GroupDimension } from '@/lib/usage-stats';
import type { FlowWindow } from '@/lib/insights-flow';
import type { ExperimentRow } from '@/lib/experiments-store';
import { toExperimentDTO } from '@/lib/experiments';
import {
  listChatRetros, listTeamsWithWorkspaces, loadAgentAccess, loadDispatchHealth, loadFailures, loadGates,
  loadInsights, loadInsightsBand, loadOperatorData, loadUsage, type InsightsBandFilter,
} from './data';
import type { AdminScope } from './scope';

export interface AdminViewer {
  /** The teams the owner is a member of, by name. */
  ownTeams: { id: string; name: string }[];
  ownTeamIds: Set<string>;
}

/** A viewer plus how one read's workspaces split between own and other teams. */
export interface ScopedViewer extends AdminViewer {
  workspaceIds: string[];
  ownWorkspaceIds: string[];
  /** The read reaches a workspace outside the owner's teams. */
  otherTeams: boolean;
}

export function scopeViewer(viewer: AdminViewer, workspaces: { id: string; teamId: string }[]): ScopedViewer {
  const ownWorkspaceIds = workspaces.filter(w => viewer.ownTeamIds.has(w.teamId)).map(w => w.id);
  return {
    ...viewer,
    workspaceIds: workspaces.map(w => w.id),
    ownWorkspaceIds,
    otherTeams: ownWorkspaceIds.length < workspaces.length,
  };
}

// ── Pseudonyms ────────────────────────────────────────────────────────────────

/** Six hex chars of the id's SHA-256: stable across reads, not the id itself. */
export function pseudonym(id: string): string {
  return createHash('sha256').update(id).digest('hex').slice(0, 6);
}
export const teamPseudonym = (id: string) => `Team ${pseudonym(id)}`;
export const workspacePseudonym = (id: string) => `Workspace ${pseudonym(id)}`;

const ownWs = (v: ScopedViewer) => new Set(v.ownWorkspaceIds);

/** A workspace's name for this viewer: its own name in an own team, else a pseudonym. */
function workspaceName(v: ScopedViewer, id: string, name: string): string {
  return ownWs(v).has(id) ? name : workspacePseudonym(id);
}

/**
 * Run a read once over every scoped workspace (for totals) and, when the scope
 * reaches other teams, again over own workspaces (for detail). With no other
 * team in scope the second read is the first. With no own workspace in scope
 * there is no detail read: `own` is null.
 */
async function splitRead<T>(v: ScopedViewer, read: (workspaceIds: string[]) => Promise<T>): Promise<{ all: T; own: T | null }> {
  if (!v.otherTeams) {
    const all = await read(v.workspaceIds);
    return { all, own: all };
  }
  const [all, own] = await Promise.all([
    read(v.workspaceIds),
    v.ownWorkspaceIds.length ? read(v.ownWorkspaceIds) : Promise.resolve(null),
  ]);
  return { all, own };
}

/** Echoed on every scoped read so the admin app can say detail is limited. */
const detailNote = (v: ScopedViewer) => ({ detailLimitedToOwnTeams: v.otherTeams });

// ── Views ─────────────────────────────────────────────────────────────────────

export async function viewUsage(v: ScopedViewer, opts: { since: Date; groupBy: GroupDimension }) {
  const usage = await loadUsage({ workspaceIds: v.workspaceIds, topTaskWorkspaceIds: v.ownWorkspaceIds, ...opts });
  const own = ownWs(v);
  return { ...usage, topTasks: usage.topTasks.filter(t => own.has(t.workspaceId)), ...detailNote(v) };
}

export async function viewInsights(v: ScopedViewer, window: FlowWindow) {
  const data = await loadInsights({ workspaceIds: v.workspaceIds, window });
  const own = ownWs(v);
  const names = data.series.workspaceNames ?? {};
  return {
    ...data,
    series: {
      ...data.series,
      tasks: data.series.tasks.filter(t => own.has(t.workspaceId)),
      workspaceNames: Object.fromEntries(Object.entries(names).map(([id, name]) => [id, workspaceName(v, id, name)])),
    },
    ...detailNote(v),
  };
}

export async function viewInsightsBand(v: ScopedViewer, filter: InsightsBandFilter) {
  const data = await loadInsightsBand({ workspaceIds: v.workspaceIds, filter });
  if (!data) return null;
  const own = ownWs(v);
  const tasks = data.tasks.filter(t => own.has(t.workspaceId));
  return { ...data, tasks, otherTeamTasks: data.tasks.length - tasks.length, ...detailNote(v) };
}

export async function viewFailures(v: ScopedViewer, opts: { window: AdminScope['window']; errorPrefix: string | null }) {
  const { all, own } = await splitRead(v, ids => loadFailures({ workspaceIds: ids, ...opts }));
  const owned = ownWs(v);
  const a = all.analytics;
  const stalled = all.stalledIngest;
  return {
    analytics: {
      ...a,
      signatures: own?.analytics.signatures ?? [],
      diedEarlySignatures: own?.analytics.diedEarlySignatures ?? [],
      repeatFailureTasks: (own?.analytics.repeatFailureTasks ?? []).filter(t => owned.has(t.workspaceId)),
      byWorkspace: a.byWorkspace.map(w => ({ ...w, workspaceName: workspaceName(v, w.workspaceId, w.workspaceName) })),
    },
    // A family is a set of signatures: own workspaces only.
    family: own?.family ?? null,
    stalledIngest: stalled && { ...stalled, jobs: stalled.jobs.filter(j => owned.has(j.workspaceId)) },
    ...detailNote(v),
  };
}

export async function viewGates(v: ScopedViewer, opts: { window: AdminScope['window']; errorPrefix: string | null }) {
  const { all, own } = await splitRead(v, ids => loadGates({ workspaceIds: ids, ...opts }));
  const ownGates = new Map((own?.gates.gates ?? []).map(g => [g.gate, g]));
  return {
    ...all,
    gates: {
      ...all.gates,
      gates: all.gates.gates.map(g => ({
        ...g,
        topReasons: ownGates.get(g.gate)?.topReasons ?? [],
        exampleTaskId: ownGates.get(g.gate)?.exampleTaskId ?? null,
      })),
    },
    ...('gateFamily' in all ? { gateFamily: own && 'gateFamily' in own ? own.gateFamily : null } : {}),
    ...detailNote(v),
  };
}

export async function viewDispatchHealth(v: ScopedViewer) {
  const report = await loadDispatchHealth(v.workspaceIds);
  return { ...report, workspaces: report.workspaces.map(w => ({ ...w, name: workspaceName(v, w.id, w.name) })) };
}

export async function viewOperator(v: ScopedViewer, since: Date) {
  const data = await loadOperatorData({ workspaceIds: v.workspaceIds, since });
  const own = ownWs(v);
  return { ...data, orphanedPrs: data.orphanedPrs && data.orphanedPrs.filter(p => own.has(p.workspaceId)), ...detailNote(v) };
}

export async function viewAgentAccess(v: ScopedViewer, windowHours: number) {
  const report = await loadAgentAccess({ workspaceIds: v.workspaceIds, windowHours });
  return report && {
    ...report,
    grantProblems: report.grantProblems.map(p => ({ ...p, workspaceName: workspaceName(v, p.workspaceId, p.workspaceName) })),
  };
}

/** Retros carry labels and counts, never message text; the team is named by pseudonym unless it is the owner's. */
export async function viewChatRetros(v: AdminViewer, opts: { teamId: string | null; since: Date; limit: number }) {
  const rows = await listChatRetros(opts);
  return rows.map(r => ({ ...r, team: teamName(v, r.teamId) }));
}

/** Every team and its workspaces: names for own teams, pseudonyms for the rest. */
export async function viewTeams(v: AdminViewer) {
  const teams = await listTeamsWithWorkspaces();
  return teams.map(t => {
    const own = v.ownTeamIds.has(t.id);
    return {
      id: t.id,
      name: own ? t.name : teamPseudonym(t.id),
      own,
      workspaces: t.workspaces.map(w => ({ id: w.id, name: own ? w.name : workspacePseudonym(w.id) })),
    };
  });
}

function teamName(v: AdminViewer, teamId: string): string {
  return v.ownTeams.find(t => t.id === teamId)?.name ?? teamPseudonym(teamId);
}

/**
 * An experiment as the owner may see it. Another team's experiment keeps its
 * kind, status, arms and dates; its key, title, hypothesis, decision and
 * config (all team-written) are replaced or dropped.
 */
export function viewExperiment(v: AdminViewer, row: ExperimentRow) {
  const dto = { ...toExperimentDTO(row), teamId: row.teamId };
  if (v.ownTeamIds.has(row.teamId)) return dto;
  const tag = pseudonym(row.id);
  return { ...dto, key: `experiment-${tag}`, title: `Experiment ${tag}`, hypothesis: null, decision: null, config: null };
}
