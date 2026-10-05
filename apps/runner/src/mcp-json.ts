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

// ─── ${VAR} expansion for mounting .mcp.json servers ─────────────────────────
//
// One expansion routine for both backends. Its whole point is that it REPORTS
// what it could not resolve: the Claude path used to replace a missing ref with
// '' and then test the result for `${`, which can never match — so a missing
// secret mounted the server with a bare `Bearer ` header and the agent saw a
// 401 dressed up as "OAuth required".
//
// An empty-string value counts as unresolved: a secret delivered as '' is still
// a missing secret, and substituting it produces the same empty header.
//
// PRECEDENCE (both backends): a claim-time connector beats a .mcp.json entry of
// the same name. The connector is the team's managed, credentialed mount; the
// file is repo-local config that may lag it. Codex used to prefer the file,
// with no recorded reason — the two backends now agree.

export interface VarExpansion {
  value: string;
  /** Referenced names with no (or an empty) value, in first-seen order. */
  unresolved: string[];
}

export function expandVarRefs(str: string, env: Record<string, string | undefined>): VarExpansion {
  const unresolved: string[] = [];
  const value = str.replace(/\$\{([^}]+)\}/g, (_, name: string) => {
    const v = env[name];
    if (v === undefined || v === '') {
      if (!unresolved.includes(name)) unresolved.push(name);
      return '';
    }
    return v;
  });
  return { value, unresolved };
}

export interface McpJsonHttpServer {
  name: string;
  url: string;
  headers: Record<string, string>;
}

export interface McpJsonSkippedServer {
  name: string;
  unresolved: string[];
  /**
   * Set when the server was refused because it asked for the agent's buildd
   * credential (`${BUILDD_API_KEY}`) somewhere it may not go: a host other
   * than this runner's buildd server, or a URL. Carries the host only.
   */
  builddCredentialRefused?: { host: string; where: 'url' | 'foreign-host' };
}

/**
 * The name a .mcp.json uses to ask for buildd auth. Reserved: it never expands
 * to the runner's own key, only to the agent's buildd credential (the per-task
 * token when one was minted), and only for a server on the runner's own buildd
 * origin. See BuilddCredentialExpansion.
 */
export const BUILDD_CREDENTIAL_VAR = 'BUILDD_API_KEY';

/**
 * How `${BUILDD_API_KEY}` expands. `origin` is the runner's buildd server
 * origin; `token` is the credential the agent's own buildd MCP entry carries.
 * A server whose URL origin is not `origin` gets nothing and is refused, as is
 * a URL that embeds the ref (URLs end up in logs).
 */
export interface BuilddCredentialExpansion {
  origin: string;
  token: string;
}

/** `new URL(url).origin`, or null when it does not parse. */
export function urlOrigin(url: string): string | null {
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : null;
  } catch {
    return null;
  }
}

export interface ResolveMcpJsonOptions {
  /** Names already mounted (e.g. by a connector) — skipped, connector wins. */
  isTaken?: (name: string) => boolean;
  /**
   * Claude only mounts entries declared `type: "http"`. Codex's config.toml has
   * one remote shape, so it accepts any entry with a url.
   */
  requireHttpType?: boolean;
  /**
   * When set, `${BUILDD_API_KEY}` is resolved by origin (see
   * BuilddCredentialExpansion) and any BUILDD_API_KEY already in `env` is
   * ignored.
   */
  builddCredential?: BuilddCredentialExpansion;
}

/**
 * Expand every remote (url-bearing) server in a parsed .mcp.json. A server with
 * ANY unresolved ref — in its url or any header — is returned in `skipped`,
 * never in `servers`: mounting it would connect without auth (or to a broken
 * host) and fail in a way the agent cannot diagnose.
 */
export function resolveMcpJsonHttpServers(
  mcpJson: unknown,
  env: Record<string, string | undefined>,
  opts: ResolveMcpJsonOptions = {},
): { servers: McpJsonHttpServer[]; skipped: McpJsonSkippedServer[] } {
  const servers: McpJsonHttpServer[] = [];
  const skipped: McpJsonSkippedServer[] = [];
  const raw = (mcpJson as { mcpServers?: unknown } | null | undefined)?.mcpServers;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { servers, skipped };

  for (const [name, cfg] of Object.entries(raw as Record<string, any>)) {
    if (name === 'buildd') continue; // reserved coordination server
    if (!cfg || typeof cfg !== 'object' || typeof cfg.url !== 'string' || !cfg.url) continue;
    if (opts.requireHttpType && cfg.type !== 'http') continue;
    if (opts.isTaken?.(name)) continue;

    let serverEnv = env;
    if (opts.builddCredential) {
      const { [BUILDD_CREDENTIAL_VAR]: _ignored, ...withoutKey } = env;
      const headerValues = Object.values((cfg.headers ?? {}) as Record<string, unknown>)
        .filter((v): v is string => typeof v === 'string');
      const inUrl = extractVarReferences(cfg.url).includes(BUILDD_CREDENTIAL_VAR);
      const inHeaders = headerValues.some(v => extractVarReferences(v).includes(BUILDD_CREDENTIAL_VAR));
      if (inUrl || inHeaders) {
        const origin = urlOrigin(expandVarRefs(cfg.url, withoutKey).value);
        const host = origin ? new URL(origin).host : '(unparseable url)';
        if (inUrl) {
          skipped.push({ name, unresolved: [BUILDD_CREDENTIAL_VAR], builddCredentialRefused: { host, where: 'url' } });
          continue;
        }
        if (origin !== opts.builddCredential.origin) {
          skipped.push({ name, unresolved: [BUILDD_CREDENTIAL_VAR], builddCredentialRefused: { host, where: 'foreign-host' } });
          continue;
        }
        serverEnv = { ...withoutKey, [BUILDD_CREDENTIAL_VAR]: opts.builddCredential.token };
      }
    }

    const unresolved: string[] = [];
    const url = expandVarRefs(cfg.url, serverEnv);
    unresolved.push(...url.unresolved);
    const headers: Record<string, string> = {};
    for (const [hk, hv] of Object.entries((cfg.headers ?? {}) as Record<string, unknown>)) {
      if (typeof hv !== 'string') continue;
      const h = expandVarRefs(hv, serverEnv);
      for (const u of h.unresolved) if (!unresolved.includes(u)) unresolved.push(u);
      headers[hk] = h.value;
    }
    if (unresolved.length > 0) {
      skipped.push({ name, unresolved });
      continue;
    }
    servers.push({ name, url: url.value, headers });
  }
  return { servers, skipped };
}

/** The connector fields the Codex config.toml builder reads. */
export interface CodexConnectorInput {
  name?: string;
  url?: string;
  headers?: Record<string, string>;
  transport?: string;
  assertionMode?: unknown;
}

export interface CodexMcpServer {
  name: string;
  url: string;
  bearerTokenEnvVar: string;
}

function envSlug(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function bearerToken(headers: Record<string, string> | undefined): string | null | undefined {
  const auth = headers?.Authorization ?? headers?.authorization;
  if (auth === undefined) return undefined;
  const m = auth.match(/^Bearer\s+(.+)$/i);
  return m ? m[1] : null;
}

/**
 * Codex reads MCP servers only from config.toml, which can carry a bearer token
 * solely by env-var NAME. Returns the server rows plus the env entries the
 * worker must set; tokens never land in config.toml.
 *
 * Connectors are processed first so they win a name collision (see PRECEDENCE).
 */
export function buildCodexMcpServers(input: {
  mcpJson: unknown;
  connectors: CodexConnectorInput[] | undefined;
  env: Record<string, string | undefined>;
  builddCredential?: BuilddCredentialExpansion;
}): { servers: CodexMcpServer[]; bearerEnv: Record<string, string>; warnings: string[] } {
  const servers: CodexMcpServer[] = [];
  const bearerEnv: Record<string, string> = {};
  const warnings: string[] = [];

  for (const conn of input.connectors ?? []) {
    if (!conn?.name || conn.name === 'buildd' || !conn.url) continue;
    if (conn.assertionMode) continue; // async mint+exchange not supported here
    if ((conn.transport ?? 'http') !== 'http') {
      warnings.push(`skipping stdio connector "${conn.name}" (not supported in config.toml)`);
      continue;
    }
    if (servers.some(s => s.name === conn.name)) continue;
    const token = bearerToken(conn.headers);
    if (token === undefined) {
      warnings.push(`connector "${conn.name}" has no Authorization header — cannot inject into config.toml`);
      continue;
    }
    if (token === null) {
      warnings.push(`connector "${conn.name}" uses non-Bearer auth — cannot inject into config.toml`);
      continue;
    }
    const envVar = `MCP_BEARER_CONN_${envSlug(conn.name)}`;
    bearerEnv[envVar] = token;
    servers.push({ name: conn.name, url: conn.url, bearerTokenEnvVar: envVar });
  }

  const { servers: fileServers, skipped } = resolveMcpJsonHttpServers(input.mcpJson, input.env, {
    isTaken: name => servers.some(s => s.name === name),
    ...(input.builddCredential ? { builddCredential: input.builddCredential } : {}),
  });
  for (const s of skipped) {
    warnings.push(describeSkippedMcpServer(s));
  }
  for (const s of fileServers) {
    const envVar = `MCP_BEARER_${envSlug(s.name)}`;
    const token = bearerToken(s.headers);
    if (token === null) {
      warnings.push(`.mcp.json server "${s.name}" uses non-Bearer auth — cannot inject into config.toml`);
      continue;
    }
    if (token) bearerEnv[envVar] = token;
    servers.push({ name: s.name, url: s.url, bearerTokenEnvVar: envVar });
  }
  return { servers, bearerEnv, warnings };
}

/**
 * One warning line for a server that was not mounted. Names the server and,
 * for a refused buildd credential, the host. Never a value.
 */
export function describeSkippedMcpServer(s: McpJsonSkippedServer): string {
  if (s.builddCredentialRefused) {
    const { host, where } = s.builddCredentialRefused;
    return where === 'url'
      ? `.mcp.json server "${s.name}" not mounted: \${${BUILDD_CREDENTIAL_VAR}} is expanded in headers only, never in a URL`
      : `.mcp.json server "${s.name}" not mounted: \${${BUILDD_CREDENTIAL_VAR}} is sent only to this runner's buildd server, not ${host}`;
  }
  return `.mcp.json server "${s.name}" not mounted: unresolved \${${s.unresolved.join('}, ${')}} (secret not delivered by the claim?)`;
}
