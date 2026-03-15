/**
 * Pure functions for parsing .mcp.json files.
 *
 * Extracted into a standalone module so they can be unit-tested without
 * mock.module() pollution from other test files that mock env-scan.
 */

export interface McpServerInfo {
  name: string;
  requiredVars: string[];
  resolved: boolean;
}

/** Extract all ${VAR} references from a string */
export function extractVarReferences(str: string): string[] {
  const matches = str.matchAll(/\$\{([^}]+)\}/g);
  const vars = new Set<string>();
  for (const m of matches) {
    vars.add(m[1]);
  }
  return [...vars];
}

/** Recursively collect all ${VAR} references from any value (string, array, object) */
function collectVarsFromValue(value: unknown): string[] {
  if (typeof value === 'string') {
    return extractVarReferences(value);
  }
  if (Array.isArray(value)) {
    return value.flatMap(v => collectVarsFromValue(v));
  }
  if (value && typeof value === 'object') {
    return Object.values(value).flatMap(v => collectVarsFromValue(v));
  }
  return [];
}

/** Parse .mcp.json content and extract server names + required env vars */
export function parseMcpJsonContent(content: string): McpServerInfo[] {
  try {
    const parsed = JSON.parse(content);
    if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
      return [];
    }

    const servers: McpServerInfo[] = [];
    for (const [name, config] of Object.entries(parsed.mcpServers)) {
      const vars = [...new Set(collectVarsFromValue(config))];
      servers.push({
        name,
        requiredVars: vars,
        resolved: false, // Will be set by scanMcpServersRich
      });
    }
    return servers;
  } catch {
    return [];
  }
}
