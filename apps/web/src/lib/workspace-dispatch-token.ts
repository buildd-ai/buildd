/**
 * Invariant: a read of a task or worker never returns its workspace's
 * dispatch token (`webhookConfig.token`), the shared secret a cloud dispatcher
 * checks on inbound dispatches. Only the workspace settings routes, for an
 * admin, handle it. Everything else in `webhookConfig` is returned as is.
 */
export function withoutDispatchToken<W extends { webhookConfig?: unknown } | null | undefined>(workspace: W): W {
  if (!workspace || !workspace.webhookConfig || typeof workspace.webhookConfig !== 'object') return workspace;
  const { token: _token, ...rest } = workspace.webhookConfig as Record<string, unknown>;
  return { ...workspace, webhookConfig: rest } as W;
}
