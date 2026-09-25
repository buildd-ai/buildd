import { requiredRoutes, type VisualQaRouteManifest } from '@buildd/core/visual-qa-routes';
import manifest from '@/qa/visual-qa-routes.json';

/**
 * buildd's required visual-QA routes for a set of changed paths: the pure
 * core mapping plus the matching entries of apps/web/src/qa/visual-qa-routes.json.
 * One wrapper so the audit description and the completion gate can't drift.
 */
export function visualQaRequiredRoutes(paths: readonly string[]): string[] {
  return requiredRoutes(paths, manifest as VisualQaRouteManifest);
}
