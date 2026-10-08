/** A scoped selection can come from any task-list entry; the query still checks team/workspace ownership. */
export interface TaskListSelection { ids: string[]; label: string }
export interface TaskListFilterInput {
  params: Record<string, string | undefined>;
  workspaceIds: string[];
  userId: string;
  teamId: string;
}
export type TaskListFilterResolver = (input: TaskListFilterInput) => Promise<TaskListSelection | null>;

export function parseTaskListSelection(params: { ids?: string | string[]; selection?: string }): TaskListSelection | null {
  if (params.ids === undefined) return null;
  const values = Array.isArray(params.ids) ? params.ids : params.ids.split(',');
  const ids = [...new Set(values.filter(id => /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)))].slice(0, 5000);
  return { ids, label: params.selection?.slice(0, 240) || 'Selected tasks' };
}
