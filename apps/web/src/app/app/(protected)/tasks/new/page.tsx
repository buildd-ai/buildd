import { redirect } from 'next/navigation';

/**
 * The new-task form is retired (owner decision 2026-10-09): a task starts as a
 * conversation. Old links land on a new task chat, keeping the workspace they
 * named (`?workspaceId=` becomes the chat's `ws`).
 */
export default async function NewTaskPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}): Promise<never> {
  const q = await searchParams;
  const raw = q.workspaceId;
  const workspaceId = Array.isArray(raw) ? raw[0] : raw;
  const params = new URLSearchParams({ new: 'task' });
  if (workspaceId) params.set('ws', workspaceId);
  redirect(`/app/chat?${params.toString()}`);
}
