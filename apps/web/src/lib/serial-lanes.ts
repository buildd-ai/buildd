/**
 * Serial lanes (Living Spec "Overlap scheduling: serial lanes and file locks",
 * Rule 1, I-1 to I-7). Pure: which lanes a task's paths put it in, and what
 * its place in a lane means for a claim. The rows live in `serial_lane_entries`
 * (lib/serial-lanes-store.ts); the order is claim-order.ts `laneOrderBy`.
 *
 *  - Lane path: a migration or schema path (`isMigrationPath`, the paths
 *    `isHardOverlapKind` calls hard) or a workspace hard surface
 *    (lib/hard-overlap-surfaces.ts). `migration` is one lane per workspace;
 *    each hard surface label is its own lane, `surface:<label>`.
 *  - Holder: the one member that is claimed, running, or has an open,
 *    unmerged PR. A pending task with no open PR never holds (I-4).
 *  - Position: how many go before this task: the holder, if any, plus the
 *    members ahead of it in the stored order, ready or not. Position 0 is
 *    "next, and the lane is free".
 */
import { isMigrationPath, REPO_WIDE_SENTINEL } from '@buildd/core/path-overlap';
import type { WorkspaceGitConfig } from '@buildd/core/db/schema';
import { resolveHardOverlapSurfaces, resolveSerializedSurfaces } from '@/lib/hard-overlap-surfaces';
import { compareLaneOrder } from '@/lib/claim-order';

export const MIGRATION_LANE = 'migration';
const SURFACE_PREFIX = 'surface:';

/** A holder PR with no commit, review or CI activity for this long is a stuck lane (I-7). */
export const STUCK_LANE_MS = 24 * 60 * 60 * 1000;

function concrete(paths: readonly string[] | null | undefined): string[] {
  return (paths ?? []).filter(p => typeof p === 'string' && p.trim() && p !== REPO_WIDE_SENTINEL);
}

/** Hard-surface labels per path; a config that cannot be read contributes none. */
function surfaceLabels(paths: string[], gitConfig: WorkspaceGitConfig | null | undefined): string[] {
  try {
    return resolveHardOverlapSurfaces(paths, gitConfig, resolveSerializedSurfaces);
  } catch (err) {
    console.warn('[serial-lanes] hard surface config unreadable; surface lanes skipped:', (err as Error)?.message ?? err);
    return [];
  }
}

/** The lanes these paths put a task in, deduplicated, migration first. */
export function laneKeysFor(paths: readonly string[] | null | undefined, gitConfig: WorkspaceGitConfig | null | undefined): string[] {
  const ps = concrete(paths);
  if (ps.length === 0) return [];
  const out: string[] = [];
  if (ps.some(isMigrationPath)) out.push(MIGRATION_LANE);
  for (const label of surfaceLabels(ps, gitConfig)) {
    const key = `${SURFACE_PREFIX}${label}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** The paths (of those given) that put a task in `lane`. */
export function lanePathsFor(paths: readonly string[] | null | undefined, gitConfig: WorkspaceGitConfig | null | undefined, lane: string): string[] {
  return concrete(paths).filter(p => laneKeysFor([p], gitConfig).includes(lane));
}

/** Plain name for a lane: "the migration lane", "the hotspot:x lane". */
export function laneName(lane: string): string {
  return `the ${lane.startsWith(SURFACE_PREFIX) ? lane.slice(SURFACE_PREFIX.length) : lane} lane`;
}

/**
 * A conflict, CI or review fix attempt for a PR (I-6). It works on that PR's
 * branch, so it never waits on, joins or takes a lane.
 */
export function isOwnPrRepair(task: {
  taskClass?: string | null;
  conflictRetryPrNumber?: number | null;
  ciRetryPrNumber?: number | null;
  reviewerRetryPrNumber?: number | null;
}): boolean {
  return task.taskClass === 'attempt'
    && (task.conflictRetryPrNumber ?? task.ciRetryPrNumber ?? task.reviewerRetryPrNumber) != null;
}

export interface LaneTask {
  id: string;
  workspaceId: string;
  pathManifest?: unknown;
  taskClass?: string | null;
  conflictRetryPrNumber?: number | null;
  ciRetryPrNumber?: number | null;
  reviewerRetryPrNumber?: number | null;
  workspace?: { gitConfig?: WorkspaceGitConfig | null } | null;
}

/** The lanes a task is in by its declared manifest. Own-PR repairs are in none (I-6). */
export function lanesOf(task: LaneTask): string[] {
  if (isOwnPrRepair(task)) return [];
  const manifest = Array.isArray(task.pathManifest) ? (task.pathManifest as string[]) : null;
  return laneKeysFor(manifest, task.workspace?.gitConfig ?? null);
}

export interface LaneMember {
  taskId: string;
  claimableSince: Date | null;
  priority: number | null;
  createdAt: Date;
  heldAt: Date | null;
  /** Claimed, running, or an open unmerged PR (and not released by a person). */
  holding: boolean;
  /** Claimable apart from the lane: pending, start time passed, not held, declared deps met. */
  ready: boolean;
  status: string;
  prNumber: number | null;
  prUrl: string | null;
  /** Last observed activity on the holder's PR (head commit, CI state, review). */
  lastActivityAt: Date | null;
}

export interface LaneView {
  workspaceId: string;
  lane: string;
  /** In stored lane order (claim-order.ts laneOrderBy). */
  members: LaneMember[];
}

export type LaneVerdict =
  | { kind: 'free' }
  | { kind: 'holder' }
  | { kind: 'held'; holder: LaneMember; position: number }
  | { kind: 'behind'; ahead: LaneMember; position: number };

/** Sort members into lane order (when read unordered). */
export function sortLane(members: LaneMember[]): LaneMember[] {
  return [...members].sort(compareLaneOrder);
}

/** How many go before `taskId`: the holder (if not itself) plus every non-holding member ahead of it. */
export function lanePosition(view: LaneView, taskId: string): number {
  const holders = view.members.filter(m => m.holding && m.taskId !== taskId).length;
  const waiting = view.members.filter(m => !m.holding);
  const idx = waiting.findIndex(m => m.taskId === taskId);
  const self = view.members.find(m => m.taskId === taskId);
  if (self?.holding) return 0;
  return holders + (idx === -1 ? waiting.length : idx);
}

/**
 * May `taskId` take the lane now (I-1, I-3, I-4)? Held by another task: no.
 * Free: only when no member ahead of it is itself ready to take it; a parked,
 * held or dependency-blocked member keeps its place and blocks nobody.
 */
export function laneVerdict(view: LaneView, taskId: string): LaneVerdict {
  const self = view.members.find(m => m.taskId === taskId);
  if (self?.holding) return { kind: 'holder' };
  const holder = view.members.find(m => m.holding && m.taskId !== taskId);
  if (holder) return { kind: 'held', holder, position: lanePosition(view, taskId) };
  const waiting = view.members.filter(m => !m.holding);
  const idx = self ? waiting.indexOf(self) : waiting.length;
  const ahead = waiting.slice(0, idx).find(m => m.ready);
  if (ahead) return { kind: 'behind', ahead, position: lanePosition(view, taskId) };
  return { kind: 'free' };
}

/** When a holder's PR went quiet, if it has been quiet for `STUCK_LANE_MS`; null otherwise (I-7). */
export function stuckSince(holder: LaneMember, now: Date, thresholdMs: number = STUCK_LANE_MS): Date | null {
  if (!holder.holding || (holder.prNumber == null && !holder.prUrl)) return null;
  const last = holder.lastActivityAt ?? holder.heldAt;
  if (!last) return null;
  return now.getTime() - last.getTime() >= thresholdMs ? last : null;
}

/** One sentence for a refusal: who holds or goes first, and where this task stands. */
export function laneSentence(lane: string, verdict: LaneVerdict, now?: Date): string {
  if (verdict.kind === 'held') {
    const stuck = now ? stuckSince(verdict.holder, now) : null;
    const pr = verdict.holder.prNumber != null ? ` (PR #${verdict.holder.prNumber})` : '';
    return `waiting in ${laneName(lane)} at position ${verdict.position}, behind task ${verdict.holder.taskId.slice(0, 8)}${pr} which holds it`
      + (stuck ? `; its PR has had no activity since ${stuck.toISOString()}` : '');
  }
  if (verdict.kind === 'behind') {
    return `waiting in ${laneName(lane)} at position ${verdict.position}: task ${verdict.ahead.taskId.slice(0, 8)} came first and takes it next`;
  }
  return '';
}
