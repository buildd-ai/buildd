/**
 * The claim loop's coordination gates as pure predicates, shared by the claim
 * route (which acts on them) and the start probe (`lib/coordination-probe.ts`,
 * which explains them before a start is accepted). One implementation, so
 * `/start` can never report a task startable that the next claim defers —
 * the "Queued at front · No runner has responded" failure — or the reverse.
 *
 * Covered: path overlap layer 1 (open PR) and layer 2 (live path claim),
 * mission concurrency, mission pacing, one scope-undeclared task per mission
 * (`advisory_manifest`), and planner order (`ordered_behind`, from the ledger).
 */
import { findBlockingPr, pathsOverlap, declaresNoScope, intersectPaths, REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import { makeWaitingReason, overlapAreas, orderWaitingReasons, type WaitingReason } from '@buildd/core/waiting-reason';
import { isDispatchedReview } from '@/lib/read-only-review';
import { splitOwnOpenPrs } from './claim-plan-input';
import { checkMissionConcurrencyGate, checkMissionPacingGate } from './pacing-gate';

/**
 * True when the task's declared deliverable is not a code change
 * ('artifact_required' / 'none'), so it cannot conflict with another task's
 * files. Same exemption the task-create manifest gate grants these tasks.
 * 'auto' and 'pr_required' still count as file-editing.
 */
export function producesNoFileEdits(outputRequirement: unknown): boolean {
  return outputRequirement === 'artifact_required' || outputRequirement === 'none';
}

export interface OpenPrTask {
  taskId: string | null;
  pathManifest: string[] | null;
  prNumber: number | null;
  prUrl: string | null;
  workerStatus: string | null;
  prLifecycle: string | null;
  branch: string | null;
  prBaseRef: string | null;
}

/** Worker statuses that mean the PR's writer is still at work. */
const LIVE_WRITER = new Set(['running', 'idle', 'starting', 'waiting_input']);

/**
 * Layer 2: the first active path claim, held by another task, that overlaps
 * this task's concrete manifest. A claim (or manifest) that is only the
 * repo-wide sentinel is advisory and never blocks.
 */
export function findActiveClaimBlocker(
  taskId: string,
  manifest: readonly string[] | null | undefined,
  activeClaims: Map<string, string[]> | null | undefined,
): { holderTaskId: string; claimedPaths: string[]; overlapPaths: string[] } | null {
  const concrete = (manifest ?? []).filter(p => p !== REPO_WIDE_SENTINEL);
  if (concrete.length === 0 || !activeClaims) return null;
  for (const [holderTaskId, claimedPaths] of activeClaims) {
    if (holderTaskId === taskId) continue; // own claims never block self
    const concreteClaimed = claimedPaths.filter(p => p !== REPO_WIDE_SENTINEL);
    if (concreteClaimed.length === 0) continue;
    if (pathsOverlap(concrete, concreteClaimed)) {
      return { holderTaskId, claimedPaths: concreteClaimed, overlapPaths: intersectPaths(concrete, concreteClaimed) };
    }
  }
  return null;
}

/** Whether the one-scope-undeclared-task-per-mission guard applies to this task at all. */
export function advisoryMutexApplies(task: { category?: unknown; outputRequirement?: unknown; pathManifest?: unknown }): boolean {
  return task.category !== 'review'
    && !producesNoFileEdits(task.outputRequirement)
    && declaresNoScope(task.pathManifest as string[] | null);
}

/** The in-flight scope-undeclared peer this task would wait behind, if any. */
export function advisoryBlockingPeer(taskId: string, peers: Set<string> | null | undefined): string | undefined {
  return peers ? [...peers].find(id => id !== taskId) : undefined;
}

export interface MissionCoordination {
  status: string;
  maxConcurrentTasks: number | null;
  pacingMode: 'eager' | 'paced';
  pacingMaxPerHour: number | null;
  lastTaskStartedAt: Date | null;
}

export interface CoordinationSnapshot {
  openPrTasks: OpenPrTask[];
  activeClaims: Map<string, string[]> | null;
  mission: MissionCoordination | null;
  missionActiveCount: number;
  missionAdvisoryInFlight: Set<string> | null;
  /** Latest planner orientation still in force (ledger), if any. */
  orderedBehind: { blockedBy: string; edge: string | null; since: string | null } | null;
  /** Tasks with a live worker, to mark a lease holder or ordering blocker live. */
  liveTaskIds: ReadonlySet<string>;
  now: Date;
}

const MAX_DRILLDOWN_PATHS = 50;
const shortId = (id: string) => id.slice(0, 8);

function overlapSentence(paths: string[]): string {
  if (paths.length === 0) return 'their declared files overlap';
  if (paths.length === 1) return `both edit ${paths[0]}`;
  const areas = overlapAreas(paths).map(a => a.area);
  return `both edit ${paths.length} files in ${areas.slice(0, 2).join(', ')}${areas.length > 2 ? ` +${areas.length - 2}` : ''}`;
}

function overlapOf(paths: string[], basis: 'pr_scope' | 'lease' | 'declared') {
  return { areas: overlapAreas(paths), pathCount: paths.length, paths: paths.slice(0, MAX_DRILLDOWN_PATHS), basis };
}

/**
 * Every coordination reason the next claim would defer this task for, in the
 * artifact's order. Empty = no coordination gate holds it.
 */
export function evaluateCoordinationGates(task: any, s: CoordinationSnapshot): WaitingReason[] {
  const out: WaitingReason[] = [];
  const manifest = (task.pathManifest as string[] | null) ?? null;

  if (manifest?.length) {
    // Layer 1: an open PR whose task's manifest overlaps this one.
    const others = splitOwnOpenPrs(task, s.openPrTasks).others;
    const pr = findBlockingPr(manifest, others);
    if (pr) {
      const entry = others.find(t => (t.prNumber ?? null) === (pr.prNumber ?? null) && (t.prUrl ?? null) === (pr.prUrl ?? null));
      const paths = intersectPaths(manifest, entry?.pathManifest ?? []);
      const live = LIVE_WRITER.has(entry?.workerStatus ?? '');
      out.push(makeWaitingReason(live ? 'pr_overlap_live' : 'pr_overlap_ended', {
        because: overlapSentence(paths),
        blocker: {
          type: 'pr',
          id: String(pr.prNumber ?? pr.prUrl ?? ''),
          label: pr.prNumber ? `PR #${pr.prNumber}` : 'an open PR',
          ...(pr.prUrl ? { href: pr.prUrl } : {}),
          live,
        },
        overlap: overlapOf(paths, 'declared'),
        provenance: { source: 'probe', derivedFrom: 'workers.prUrl ∩ tasks.pathManifest (claim layer 1)' },
      }));
    }

    // Layer 2: a live lease another task holds on these files.
    const lease = findActiveClaimBlocker(task.id, manifest, s.activeClaims);
    if (lease) {
      out.push(makeWaitingReason('lease_overlap', {
        because: overlapSentence(lease.overlapPaths),
        blocker: { type: 'task', id: lease.holderTaskId, label: `task ${shortId(lease.holderTaskId)}`, href: `/app/tasks/${lease.holderTaskId}`, live: s.liveTaskIds.has(lease.holderTaskId) },
        overlap: overlapOf(lease.overlapPaths, 'lease'),
        provenance: { source: 'probe', derivedFrom: 'path_claims (claim layer 2)' },
      }));
    }
  }

  const missionId = task.missionId as string | null;
  if (missionId && s.mission) {
    // Reviews are exempt from the mission's concurrency cap and pacing.
    const isReview = isDispatchedReview(task.category, task.context);
    const conc = !isReview && checkMissionConcurrencyGate(s.mission.maxConcurrentTasks, s.missionActiveCount);
    if (conc) {
      out.push(makeWaitingReason('mission_concurrent', {
        because: `the mission runs at most ${conc.cap} task${conc.cap === 1 ? '' : 's'} at once and ${conc.active} ${conc.active === 1 ? 'is' : 'are'} running`,
        blocker: { type: 'mission', id: missionId, label: 'the mission limit', href: `/app/missions/${missionId}` },
        provenance: { source: 'probe', derivedFrom: 'missions.maxConcurrentTasks' },
      }));
    }
    const paced = !isReview && checkMissionPacingGate(s.mission, s.now);
    if (paced) {
      out.push(makeWaitingReason('mission_paced', {
        because: `the mission starts a task at most every ${Math.round(paced.intervalSec / 60)} min; next at ${paced.nextEligibleAt.toISOString()}`,
        blocker: { type: 'mission', id: missionId, label: 'mission pacing', href: `/app/missions/${missionId}` },
        provenance: { source: 'probe', derivedFrom: 'missions.pacingMode' },
      }));
    }
    const peer = advisoryMutexApplies(task) ? advisoryBlockingPeer(task.id, s.missionAdvisoryInFlight) : undefined;
    if (peer) {
      out.push(makeWaitingReason('scope_undeclared_mutex', {
        because: 'neither task declares the files it edits, so the mission runs one at a time',
        blocker: { type: 'task', id: peer, label: `task ${shortId(peer)}`, href: `/app/tasks/${peer}`, live: true },
        provenance: { source: 'probe', derivedFrom: 'tasks.pathManifest (advisory_manifest)' },
      }));
    }
  }

  if (s.orderedBehind && s.liveTaskIds.has(s.orderedBehind.blockedBy)) {
    const b = s.orderedBehind.blockedBy;
    out.push(makeWaitingReason('ordered_behind', {
      because: `the planner ordered it after a task it may conflict with${s.orderedBehind.edge ? ` (${s.orderedBehind.edge.replace(/_/g, ' ')})` : ''}`,
      blocker: { type: 'task', id: b, label: `task ${shortId(b)}`, href: `/app/tasks/${b}`, live: true },
      provenance: { source: 'ledger', derivedFrom: 'gate_events#claim_loop_deferral/ordered_behind', ...(s.orderedBehind.since ? { firstSeenAt: s.orderedBehind.since } : {}) },
    }));
  }

  return orderWaitingReasons(out);
}
