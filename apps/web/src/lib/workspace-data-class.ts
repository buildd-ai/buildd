/**
 * The one sensitivity predicate for a workspace row. Pure (no DB), so any
 * module can import it without pulling in the database layer.
 *
 * Sensitive by either marker: the `data_class` column, or the older
 * `gitConfig.dataClass` flag. A caller with no row must treat the workspace
 * as not standard (skip), never as standard.
 */
export function isStandardWorkspace(ws: { dataClass?: string | null; gitConfig?: { dataClass?: string } | null }): boolean {
  return ws.dataClass === 'standard' && ws.gitConfig?.dataClass !== 'sensitive';
}
