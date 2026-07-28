/** Pattern for 401-class auth failures from MCP connector tool results. */
export const AUTH_401_PATTERN =
  /\b(401|unauthorized|authentication.*failed|invalid.*token|token.*expired|access.*denied)\b/i;

/**
 * Pattern for 403 "Resource not accessible by integration" — GitHub App permission gap.
 * This is distinct from a 401 (expired/invalid token); the token is valid but the
 * GitHub App installation lacks the required permission scope (e.g. pull_requests: write).
 */
export const AUTH_403_PERMISSION_PATTERN = /resource not accessible by integration/i;

export interface ConnectorRef {
  id: string;
  name: string;
  url: string;
}

/** Normalise a connector display name to a MCP server-key fragment. */
export function toServerKey(connectorName: string): string {
  return connectorName.toLowerCase().replace(/[^a-z0-9_]/g, '_');
}

/**
 * Extract the server-key fragment from an MCP tool name.
 * `mcp__github__list_repos` → `"github"`
 * Returns undefined for non-MCP tool names.
 */
export function extractServerKey(toolName: string): string | undefined {
  if (!toolName.startsWith('mcp__')) return undefined;
  return toolName.split('__')[1];
}

/**
 * Resolve the connector that owns an MCP tool result.
 * Returns undefined when the source is not an MCP tool or no connector matches.
 */
export function findConnectorFor(
  source: string | undefined,
  connectors: ConnectorRef[],
): ConnectorRef | undefined {
  if (!source || !source.startsWith('mcp__')) return undefined;
  const serverKey = extractServerKey(source);
  return connectors.find(c => toServerKey(c.name) === serverKey);
}

/**
 * Decide whether the 401 circuit breaker should fire for this connector.
 *
 * Assertion-mode connectors silently re-exchange tokens via the PostToolUseFailure
 * hook (§F.2 in assertion-grant spec). The breaker fires only once re-exchange is
 * exhausted (`assertionReAuthFailed` carries the connector name).  For oauth/static
 * connectors the breaker fires immediately on the first 401.
 */
export function shouldFireCircuitBreaker(
  connector: ConnectorRef,
  assertionConnectors: { name: string }[],
  assertionReAuthFailed: Set<string>,
): boolean {
  const isAssertion = assertionConnectors.some(a => a.name === connector.name);
  const reAuthFailed = assertionReAuthFailed.has(connector.name);
  return !isAssertion || reAuthFailed;
}

/** Returns true when an error-block text indicates a 401-class auth failure. */
export function is401Error(text: string): boolean {
  return AUTH_401_PATTERN.test(text);
}

/**
 * Returns true when an error-block text indicates a 403 GitHub App permission gap.
 * The token is valid; the App installation is missing the required permission scope.
 */
export function is403PermissionError(text: string): boolean {
  return AUTH_403_PERMISSION_PATTERN.test(text);
}
