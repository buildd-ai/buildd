/**
 * Claim-time soft overlap: the HOLD/START half of the hard/soft path-overlap
 * split (`partitionOverlapEdges`, packages/core/path-overlap.ts).
 *
 * A task's `pathDeclaration.softOverlaps` names in-flight tasks whose declared
 * scope overlapped its own at creation by directory prefix or on the same
 * file, plus (`legacy_inferred`) dependsOn edges minted before the split,
 * which migration 0267 moved here. None of them is a dependsOn edge. At claim
 * each is re-evaluated against the CURRENT manifests:
 *
 *  - holder terminal, gone, or no longer overlapping → clear;
 *  - migration path or workspace hard surface (serialized namespace, generated
 *    file, explicit hotspot: ../../../../lib/hard-overlap-surfaces.ts) →
 *    deterministic HOLD while the holder is in flight (Jev never sees it);
 *  - same file or prefix-only → advisory: the claim route holds unless an
 *    applied Jev START exists for this exact state (`soft_overlap` gate in
 *    hold-start-shadow.ts), and a live lease on the actual files still wins.
 *
 * Unknown state (the holder read failed, or the hard-surface check threw) is a
 * deterministic HOLD: fail closed. Pure: no DB. The route reads the holders.
 */
import { isTerminalTaskStatus } from '@buildd/shared';
import { classifyManifestOverlap, isHardOverlapKind, readSoftOverlaps, type ManifestOverlapKind } from '@buildd/core/path-overlap';

export { readSoftOverlaps };

export interface SoftHolderRow {
  id: string;
  status: string;
  pathManifest: string[] | null;
  /** The holder's newest worker status; null before it ever started. */
  workerStatus: string | null;
  title: string | null;
}

export type SoftOverlapVerdict =
  | { kind: 'deterministic'; holderTaskId: string; paths: string[]; overlapKind: 'migration' | 'hard_surface' | 'state_unresolved'; holderTitle: string | null }
  | { kind: 'advisory'; holderTaskId: string; paths: string[]; overlapKind: SoftOverlapKind; workerStatus: string | null; holderTitle: string | null };

/** What a Jev-decided soft overlap shares: one file on both sides, or only a directory. */
export type SoftOverlapKind = 'same_file' | 'prefix';

/** Every soft holder named by the candidates, for one batched read. */
export function softOverlapHolderIds(candidates: ReadonlyArray<{ id: string; pathDeclaration?: unknown }>): Set<string> {
  const ids = new Set<string>();
  for (const t of candidates) for (const e of readSoftOverlaps(t.pathDeclaration)) if (e.taskId !== t.id) ids.add(e.taskId);
  return ids;
}

/**
 * The soft overlaps that still hold this candidate, in declaration order.
 * `holders` null means the read failed: every entry is unknown state.
 */
export function evaluateSoftOverlaps(
  task: { id: string; pathManifest: string[] | null | undefined; pathDeclaration?: unknown },
  holders: ReadonlyMap<string, SoftHolderRow> | null,
  opts: { isHardSurface: (paths: string[], kind: ManifestOverlapKind) => boolean },
): SoftOverlapVerdict[] {
  const out: SoftOverlapVerdict[] = [];
  for (const e of readSoftOverlaps(task.pathDeclaration)) {
    if (e.taskId === task.id) continue;
    if (!holders) {
      out.push({ kind: 'deterministic', holderTaskId: e.taskId, paths: e.paths, overlapKind: 'state_unresolved', holderTitle: null });
      continue;
    }
    const h = holders.get(e.taskId);
    if (!h || isTerminalTaskStatus(h.status)) continue;
    const overlap = classifyManifestOverlap(task.pathManifest ?? null, h.pathManifest);
    if (overlap.kind === 'none') continue;
    if (isHardOverlapKind(overlap.kind)) {
      out.push({ kind: 'deterministic', holderTaskId: h.id, paths: overlap.paths, overlapKind: 'migration', holderTitle: h.title });
      continue;
    }
    let hard: boolean;
    try { hard = opts.isHardSurface(overlap.paths, overlap.kind); } catch { hard = true; }
    if (hard) {
      out.push({ kind: 'deterministic', holderTaskId: h.id, paths: overlap.paths, overlapKind: 'hard_surface', holderTitle: h.title });
      continue;
    }
    out.push({
      kind: 'advisory',
      holderTaskId: h.id,
      paths: overlap.paths,
      overlapKind: overlap.kind === 'exact_file' ? 'same_file' : 'prefix',
      workerStatus: h.workerStatus,
      holderTitle: h.title,
    });
  }
  return out;
}
