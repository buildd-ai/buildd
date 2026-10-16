/** Shared, conservative attribution for the claim readout and learning dial. */
import { REPO_WIDE_SENTINEL, pathsOverlap } from './path-overlap';
import type { DecisionForJoin, DecisionOutcomeLabels, GateEventForJoin } from './orchestration-outcomes';
export type ClaimArea = 'core/db' | 'other' | 'unknown';
export function claimAreaClass(paths: readonly string[]): ClaimArea {
  if (!paths.length || paths.includes(REPO_WIDE_SENTINEL))
    return 'unknown';
  return paths.some(p => p.startsWith('packages/core/') || /(^|\/)db\//.test(p) || /(^|\/)drizzle\//.test(p)) ? 'core/db' : 'other';
}
export interface ClaimReceipt {
  paths: string[];
  blockerTaskIds: string[];
  staleBlocker: boolean;
}
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' ? v as Record<string, unknown> : {};
const strings = (v: unknown): string[] => Array.isArray(v) ? v.filter((s): s is string => typeof s === 'string') : [];
/** Accept old human receipts too. Missing evidence stays empty, never invented. */
export function claimReceipt(raw: unknown): ClaimReceipt {
  const r = object(raw);
  const c = object(r.coordination ?? raw);
  const paths = strings(c.paths);
  const ids = [...strings(c.blockerTaskIds), ...strings([c.holderTaskId])];
  let stale = c.staleBlocker === true || object(c.blocker).stale === true;
  for (const entry of Array.isArray(r.blockers) ? r.blockers : []) {
    const b = object(entry);
    paths.push(...strings(object(b.overlap).paths), ...strings(b.sharedPaths));
    for (const inner of Array.isArray(b.blockers) ? b.blockers : [b]) {
      const i = object(inner);
      if (i.type === 'task' || i.type === undefined)
        ids.push(...strings([i.id]));
      if (i.stale === true)
        stale = true;
    }
    if (b.stale === true)
      stale = true;
  }
  return { paths: [...new Set(paths)], blockerTaskIds: [...new Set(ids)], staleBlocker: stale };
}
/** null is unknown/censored. A clean run must land before it can be safe. */
export function attributeClaimOutcome(d: DecisionForJoin, receipt: ClaimReceipt, label: DecisionOutcomeLabels, events: readonly GateEventForJoin[]): boolean | null {
  if (label.risk.status !== 'observed')
    return null;
  if (!label.risk.value)
    return label.touched.status === 'observed' && label.touched.value.landed ? false : null;
  let unknown = false;
  for (const [dim, gate] of [[label.collision, 'path_claim'], [label.mergeBaseRefusal, 'merge_base_freshness']] as const) {
    if (dim.status !== 'observed' || !dim.value)
      continue;
    const matches = events.filter(e => e.workspaceId === d.workspaceId && e.gate === gate && e.occurredAt >= d.createdAt
      && (e.taskId === d.taskId || e.detail?.blockingTaskId === d.taskId));
    if (!matches.length) {
      unknown = true;
      continue;
    }
    for (const e of matches) {
      const detail = e.detail ?? {};
      const counterparty = e.taskId === d.taskId ? detail.blockingTaskId : e.taskId;
      const paths = [...strings(detail.paths), ...strings(detail.conflictingFiles), ...strings(detail.behindPaths), ...strings([detail.path])];
      const partyMatches = typeof counterparty === 'string' && receipt.blockerTaskIds.includes(counterparty);
      const pathMatches = paths.length > 0 && receipt.paths.length > 0 && pathsOverlap(paths, receipt.paths);
      // Collisions need either path or counterparty; a base refusal needs both.
      if (gate === 'path_claim' ? partyMatches || pathMatches : partyMatches && pathMatches)
        return true;
      const partyKnown = receipt.blockerTaskIds.length > 0 && typeof counterparty === 'string';
      const pathsKnown = receipt.paths.length > 0 && paths.length > 0;
      const provenUnrelated = gate === 'path_claim'
        ? partyKnown && pathsKnown
        : (partyKnown && !partyMatches) || (pathsKnown && !pathMatches);
      if (!provenUnrelated) unknown = true;
    }
  }
  // Existing conflict-retry rows do not carry conflicting files + merging
  // counterparty. They are never treated as attributable without that evidence.
  if (label.conflictCreated.status === 'observed' && label.conflictCreated.value)
    unknown = true;
  return unknown || label.touched.status !== 'observed' || !label.touched.value.landed ? null : false;
}
