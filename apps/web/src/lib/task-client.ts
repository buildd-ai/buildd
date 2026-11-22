/**
 * Which client filed a task, from `context.client` (set by the filing API caller,
 * e.g. the ACP bridge) — never from the title or description.
 * Shape: `{ kind: 'acp', name?: string }`; `name` is the client's own name from
 * ACP `initialize` clientInfo, so any ACP client is labelled as itself.
 */
export const TASK_CLIENT_KEY = 'client' as const;

export interface TaskClient {
  kind: 'acp';
  name?: string;
}

const MAX_NAME = 60;

function cleanName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME).trim();
  return name || undefined;
}

/** The marker the ACP bridge sends when it files a task. */
export function acpClient(clientInfo: { name?: unknown } | null | undefined): TaskClient {
  const name = cleanName(clientInfo?.name);
  return name ? { kind: 'acp', name } : { kind: 'acp' };
}

/** "from T3 Code", or null when the task carries no (valid) client marker. */
export function taskClientLabel(context: unknown): string | null {
  if (!context || typeof context !== 'object') return null;
  const client = (context as Record<string, unknown>)[TASK_CLIENT_KEY];
  if (!client || typeof client !== 'object') return null;
  const { kind, name } = client as Record<string, unknown>;
  if (kind !== 'acp') return null;
  const clean = cleanName(name);
  return clean ? `from ${clean}` : 'from an ACP client';
}
