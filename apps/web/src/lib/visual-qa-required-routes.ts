import { requiredRoutes, type VisualQaRouteManifest } from '@buildd/core/visual-qa-routes';
import { isTrunkRefreshTask } from '@buildd/core/surface-audit';
import manifest from '@/qa/visual-qa-routes.json';

/**
 * buildd's required visual-QA routes for a set of changed paths: the pure
 * core mapping plus the matching entries of apps/web/src/qa/visual-qa-routes.json.
 * One wrapper so the audit description and the completion gate can't drift.
 */
export function visualQaRequiredRoutes(paths: readonly string[]): string[] {
  return requiredRoutes(paths, manifest as VisualQaRouteManifest);
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The fields of an audit dependency the route derivation reads. */
export interface AuditDependency {
  pathManifest?: unknown;
  title?: string | null;
  context?: unknown;
}

/**
 * A `[surface audit]` task's required routes: the routes of its dependencies'
 * changed files (their `pathManifest`s; a `**` wildcard names no route) unioned
 * with `context.visualQa.requiredRoutes`, which the round-2 planner freezes.
 * A dependency that merges trunk in (`isTrunkRefreshTask`) contributes nothing:
 * its manifest is trunk's diff, and a shared layout in it would demand every
 * route under /app. Recomputed rather than read from the description, since
 * later builder tasks extend `dependsOn`. The completion gate
 * (`loadVisualAuditEvidence`), the claim-time route block and the mission
 * page's n/m coverage all call this, so they cannot drift.
 */
export function auditRequiredRoutes(
  audit: { context?: unknown },
  deps: ReadonlyArray<AuditDependency | null | undefined>,
): string[] {
  const paths = deps
    .filter((d): d is AuditDependency => !!d && !isTrunkRefreshTask(d))
    .flatMap((d) => (Array.isArray(d.pathManifest) ? d.pathManifest : []))
    .filter((p): p is string => typeof p === 'string' && p !== '**');
  const ctx = isRecord(audit.context) ? audit.context : {};
  const frozen = isRecord(ctx.visualQa) && Array.isArray(ctx.visualQa.requiredRoutes)
    ? (ctx.visualQa.requiredRoutes as unknown[]).filter((r): r is string => typeof r === 'string' && r.startsWith('/'))
    : [];
  return [...new Set([...visualQaRequiredRoutes(paths), ...frozen])].sort();
}
