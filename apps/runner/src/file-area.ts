/**
 * Which part of the repo a file tool touched: Read, Edit, Write, MultiEdit and
 * NotebookEdit calls counted per area, so usage can say where reading and
 * editing time goes instead of one opaque bar per tool.
 *
 * Only the area is kept, never a path or file content: the top-level directory
 * of the worktree, two levels for monorepo containers (`apps/web`,
 * `packages/core`). Anything outside the worktree (scratch dirs, home config)
 * is one bucket. Stored on `resultMeta.fileToolAreas`.
 */

export const FILE_AREA_TOOLS = ['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit'] as const;
const FILE_AREA_TOOL_SET: ReadonlySet<string> = new Set(FILE_AREA_TOOLS);

/** Areas a repo groups packages under; their children are the useful level. */
const CONTAINER_DIRS: ReadonlySet<string> = new Set(['apps', 'packages', 'services', 'libs']);

export const ROOT_AREA = '(repo root)';
export const OUTSIDE_AREA = '(outside the repo)';
export const OVERFLOW_AREA = '(other)';
/** Distinct areas kept per tool before the rest fold into `OVERFLOW_AREA`. */
export const MAX_AREAS_PER_TOOL = 24;

export function isFileAreaTool(toolName: string): boolean {
  return FILE_AREA_TOOL_SET.has(toolName);
}

/** The path argument a file tool was called with, if any. */
export function filePathInput(toolName: string, input: unknown): unknown {
  if (!isFileAreaTool(toolName) || !input || typeof input !== 'object') return undefined;
  const i = input as { file_path?: unknown; notebook_path?: unknown };
  return toolName === 'NotebookEdit' ? i.notebook_path : i.file_path;
}

export function fileAreaOf(filePath: unknown, root: string | undefined): string | null {
  if (typeof filePath !== 'string' || filePath.length === 0) return null;
  let rel: string;
  if (filePath.startsWith('/')) {
    if (!root) return OUTSIDE_AREA;
    const base = root.endsWith('/') ? root : `${root}/`;
    if (!filePath.startsWith(base)) return OUTSIDE_AREA;
    rel = filePath.slice(base.length);
  } else {
    rel = filePath;
  }
  const segments = rel.split('/').filter(s => s.length > 0 && s !== '.');
  if (segments.length === 0) return null;
  if (segments[0] === '..') return OUTSIDE_AREA;
  if (segments.length === 1) return ROOT_AREA;
  const first = segments[0];
  if (CONTAINER_DIRS.has(first) && segments.length > 2) return `${first}/${segments[1]}`;
  return first;
}

/** Count one call in place, capping distinct areas per tool. */
export function recordFileArea(into: Record<string, Record<string, number>>, toolName: string, area: string): void {
  const areas = (into[toolName] ??= {});
  const known = areas[area] !== undefined;
  const key = known || Object.keys(areas).length < MAX_AREAS_PER_TOOL ? area : OVERFLOW_AREA;
  areas[key] = (areas[key] ?? 0) + 1;
}
