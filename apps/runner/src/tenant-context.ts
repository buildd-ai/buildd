/**
 * Tenant context from a task's context field (Dispatch multi-tenant mode).
 *
 * Only names the tenant for the prompt. It carries no credential: buildd does
 * not store, decrypt or hand out a subscription login, so the agent's model
 * auth is always the runner machine's own login or an API key.
 */
export interface TenantContext {
  tenantId: string;
  displayName?: string;
  dispatchUrl?: string;
}

/**
 * Extract and validate tenant context from a task's context field.
 * Returns null if no tenant context is present.
 */
export function extractTenantContext(
  taskContext: Record<string, unknown> | null | undefined,
): TenantContext | null {
  if (!taskContext) return null;

  const tc = taskContext.tenantContext as TenantContext | undefined;
  if (!tc || !tc.tenantId) return null;

  return tc;
}
