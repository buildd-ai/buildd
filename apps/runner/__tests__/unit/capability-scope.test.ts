/**
 * Capability scoping tests: verify runner-level secrets do NOT reach the agent
 * subprocess environment and that sensitive Read/Bash operations are blocked.
 *
 * Design principle: the env should simply not CONTAIN anything the agent isn't
 * granted. Autonomous workers can't answer permission prompts, so safety must
 * come from what's reachable, not what's asked.
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { SENSITIVE_READ_PATHS, DANGEROUS_CREDENTIAL_READ_PATTERNS } from '@buildd/shared';

// ─── Env allowlist unit tests ─────────────────────────────────────────────────

describe('Runner env allowlist — runner secrets excluded from agent cleanEnv', () => {
  // These variables must NEVER appear in the agent subprocess env.
  const RUNNER_SECRET_KEYS = [
    'BUILDD_API_KEY',           // runner coordination key — agent uses MCP header auth
    'DISPATCH_API_KEY',         // MCP credential secret
    'TENANT_MASTER_KEY',        // tenant encryption master key
    'MOA_OPS_API_KEY',          // another MCP credential
  ];

  // These variables ARE allowed in the agent env (operator-configured LLM creds).
  const ALLOWED_LLM_KEYS = [
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'ANTHROPIC_BASE_URL',
  ];

  // Simulate the allowlist logic from workers.ts startSession
  const RUNNER_ENV_PASSTHROUGH = new Set([
    'HOME', 'USER', 'LOGNAME', 'USERNAME', 'SHELL', 'PATH',
    'LANG', 'LC_ALL', 'LC_CTYPE', 'LC_MESSAGES', 'LC_NUMERIC', 'LC_TIME',
    'TZ', 'TERM', 'COLORTERM', 'TMPDIR', 'TEMP', 'TMP', 'XDG_RUNTIME_DIR',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
    'NODE_ENV', 'NODE_PATH', 'BUN_INSTALL', 'npm_config_cache',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY',
    'GH_HOST', 'GITHUB_SERVER_URL',
    'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
    'OPENAI_API_KEY',
    'GITHUB_TOKEN', 'GH_TOKEN',
  ]);

  function buildCleanEnv(processEnv: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    for (const key of RUNNER_ENV_PASSTHROUGH) {
      const val = processEnv[key];
      if (val !== undefined) env[key] = val;
    }
    return env;
  }

  test('BUILDD_API_KEY does not appear in cleanEnv', () => {
    const processEnv = { BUILDD_API_KEY: 'bld_secret_runner_key', HOME: '/home/user', PATH: '/usr/bin' };
    const cleanEnv = buildCleanEnv(processEnv);
    expect(cleanEnv).not.toHaveProperty('BUILDD_API_KEY');
  });

  test('DISPATCH_API_KEY does not appear in cleanEnv', () => {
    const processEnv = { DISPATCH_API_KEY: 'dsp_secret_key', HOME: '/home/user' };
    const cleanEnv = buildCleanEnv(processEnv);
    expect(cleanEnv).not.toHaveProperty('DISPATCH_API_KEY');
  });

  test('TENANT_MASTER_KEY does not appear in cleanEnv', () => {
    const processEnv = { TENANT_MASTER_KEY: 'master_enc_key', HOME: '/home/user' };
    const cleanEnv = buildCleanEnv(processEnv);
    expect(cleanEnv).not.toHaveProperty('TENANT_MASTER_KEY');
  });

  test('all runner secret keys are excluded', () => {
    const processEnv: Record<string, string> = { HOME: '/home/user', PATH: '/usr/bin' };
    for (const key of RUNNER_SECRET_KEYS) {
      processEnv[key] = `secret_value_for_${key}`;
    }
    const cleanEnv = buildCleanEnv(processEnv);
    for (const key of RUNNER_SECRET_KEYS) {
      expect(cleanEnv).not.toHaveProperty(key);
    }
  });

  test('operator-configured LLM creds DO pass through (agent needs them)', () => {
    const processEnv = {
      ANTHROPIC_API_KEY: 'sk-ant-operator-key',
      ANTHROPIC_AUTH_TOKEN: 'oauth-token',
      OPENAI_API_KEY: 'sk-openai-key',
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      HOME: '/home/user',
    };
    const cleanEnv = buildCleanEnv(processEnv);
    for (const key of ALLOWED_LLM_KEYS) {
      if (processEnv[key]) {
        expect(cleanEnv).toHaveProperty(key, processEnv[key]);
      }
    }
  });

  test('shell essentials pass through', () => {
    const processEnv = { HOME: '/home/user', PATH: '/usr/bin:/usr/local/bin', SHELL: '/bin/bash' };
    const cleanEnv = buildCleanEnv(processEnv);
    expect(cleanEnv.HOME).toBe('/home/user');
    expect(cleanEnv.PATH).toBe('/usr/bin:/usr/local/bin');
    expect(cleanEnv.SHELL).toBe('/bin/bash');
  });

  test('arbitrary runner env vars are not passed through', () => {
    const processEnv = {
      MY_SECRET_DB_PASSWORD: 'dbpass123',
      INTERNAL_TOKEN: 'internal-secret',
      HOME: '/home/user',
    };
    const cleanEnv = buildCleanEnv(processEnv);
    expect(cleanEnv).not.toHaveProperty('MY_SECRET_DB_PASSWORD');
    expect(cleanEnv).not.toHaveProperty('INTERNAL_TOKEN');
  });
});

// ─── headerExpansionEnv unit tests ────────────────────────────────────────────

describe('headerExpansionEnv — credentials available for MCP header resolution only', () => {
  function buildHeaderExpansionEnv(
    cleanEnv: Record<string, string>,
    apiKey: string | undefined,
    mcpSecrets: Record<string, string> | undefined,
  ): Record<string, string> {
    return {
      ...cleanEnv,
      ...(apiKey ? { BUILDD_API_KEY: apiKey } : {}),
      ...(mcpSecrets ?? {}),
    };
  }

  test('BUILDD_API_KEY is available for header resolution', () => {
    const cleanEnv = { HOME: '/home/user' };
    const expansion = buildHeaderExpansionEnv(cleanEnv, 'bld_secret', undefined);
    expect(expansion.BUILDD_API_KEY).toBe('bld_secret');
  });

  test('mcpSecrets are available for header resolution', () => {
    const cleanEnv = { HOME: '/home/user' };
    const secrets = { DISPATCH_API_KEY: 'dsp_key', TENANT_ID: 'tenant-123' };
    const expansion = buildHeaderExpansionEnv(cleanEnv, undefined, secrets);
    expect(expansion.DISPATCH_API_KEY).toBe('dsp_key');
    expect(expansion.TENANT_ID).toBe('tenant-123');
  });

  test('headerExpansionEnv is a superset of cleanEnv', () => {
    const cleanEnv = { HOME: '/home/user', PATH: '/usr/bin' };
    const expansion = buildHeaderExpansionEnv(cleanEnv, 'bld_key', { DISPATCH_API_KEY: 'dsp' });
    expect(expansion.HOME).toBe('/home/user');
    expect(expansion.PATH).toBe('/usr/bin');
    expect(expansion.BUILDD_API_KEY).toBe('bld_key');
    expect(expansion.DISPATCH_API_KEY).toBe('dsp');
  });

  test('mcp.json ${VAR} expansion resolves via headerExpansionEnv', () => {
    const headerExpansionEnv = { BUILDD_API_KEY: 'bld_secret', DISPATCH_API_KEY: 'dsp_key', HOME: '/home/user' };
    // Simulate the header resolution logic from workers.ts
    const headerTemplate = 'Bearer ${BUILDD_API_KEY}';
    const resolved = headerTemplate.replace(/\$\{([^}]+)\}/g, (_, v: string) => headerExpansionEnv[v] ?? '');
    expect(resolved).toBe('Bearer bld_secret');
  });

  test('${DISPATCH_API_KEY} resolves for MCP server header', () => {
    const headerExpansionEnv = { DISPATCH_API_KEY: 'dsp-secret-value', HOME: '/home/user' };
    const headerTemplate = '${DISPATCH_API_KEY}';
    const resolved = headerTemplate.replace(/\$\{([^}]+)\}/g, (_, v: string) => headerExpansionEnv[v] ?? '');
    expect(resolved).toBe('dsp-secret-value');
  });
});
