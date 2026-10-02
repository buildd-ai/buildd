/**
 * Path declaration outcomes and manifest provenance — the denominators
 * conflict-aware-orchestration.md §3 asks for. The generic MCP tool histogram
 * counts calls; it cannot say how many declarations succeeded, how many a live
 * holder denied, how many went ahead degraded because coordination was
 * unreachable, or where a task's manifest came from. One `path_declaration`
 * gate row per outcome answers all four (`get_failure_analytics family=gate`).
 */
import { fireGateEvent, GATE_SLUGS } from '@/lib/gate-ledger';
import type { GateCallerOrigin } from '@buildd/core/gate-events';

export type DeclarationResult = 'succeeded' | 'denied' | 'degraded';
export type DeclarationProvenance = 'creation' | 'plan_step' | 'doc_fix' | 'check_path_claim' | 'observed' | 'hook';
export type ManifestShape = 'none' | 'sentinel' | 'concrete' | 'mixed';

const OUTCOME = { succeeded: 'accepted', denied: 'deferred', degraded: 'warned' } as const;
const REASON = {
  succeeded: 'path declaration recorded',
  denied: 'path declaration denied by a live holder',
  degraded: 'path declaration degraded: coordination unavailable, edits proceeded',
} as const;

export function manifestShape(manifest: unknown): ManifestShape {
  if (!Array.isArray(manifest) || manifest.length === 0) return 'none';
  const sentinel = manifest.filter((p) => typeof p === 'string' && p.trim() === '**').length;
  if (sentinel === 0) return 'concrete';
  return sentinel === manifest.length ? 'sentinel' : 'mixed';
}

export function recordPathDeclaration(input: {
  result: DeclarationResult;
  provenance: DeclarationProvenance;
  surface: string;
  workspaceId: string | null;
  missionId?: string | null;
  taskId: string | null;
  workerId?: string | null;
  callerOrigin: GateCallerOrigin;
  pathCount: number;
  detail?: Record<string, unknown>;
}): void {
  if (!(input.pathCount > 0) && input.provenance !== 'creation') return;
  try {
    fireGateEvent({
      gate: GATE_SLUGS.PATH_DECLARATION,
      surface: input.surface,
      outcome: OUTCOME[input.result],
      reason: REASON[input.result],
      workspaceId: input.workspaceId,
      missionId: input.missionId ?? null,
      taskId: input.taskId,
      workerId: input.workerId ?? null,
      callerOrigin: input.callerOrigin,
      detail: { provenance: input.provenance, result: input.result, pathCount: input.pathCount, ...(input.detail ?? {}) },
    });
  } catch {
    // A counter is never what fails a declaration.
  }
}
