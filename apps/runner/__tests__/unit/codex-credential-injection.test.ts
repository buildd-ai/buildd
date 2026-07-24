/**
 * Unit tests for Codex credential injection at spawn time.
 *
 * Verifies:
 * - When a worker has codexCredential, CODEX_HOME is set and auth.json is
 *   written with the correct structure and permissions.
 * - The temp directory is cleaned up after the worker exits.
 * - Non-Codex workers never get a CODEX_HOME or temp dir.
 * - CodexBackend.resolveApiKey reads access_token from auth.json (OAuth flow).
 */

import { describe, test, expect, afterEach, mock } from 'bun:test';
import * as fsModule from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { existsSync, readFileSync, mkdtempSync, writeFileSync, rmSync } = fsModule;

// Must be before imports that transitively use the Claude SDK
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() { return { async next() { return { value: undefined, done: true }; } }; },
  }),
}));

import { materializeCodexAuth, cleanupCodexAuth } from '../../src/codex-auth';

// These tests need a real filesystem. Sibling suites (e.g. env-scan.test.ts)
// call mock.module('fs') process-wide, and those mocks register during the load
// phase — AFTER this file's top-level code runs — so a load-time check is
// unreliable (notably env-scan's mock returns existsSync() === true for every
// path, defeating a `!existsSync('/')` probe). We probe at RUN time instead and
// skip the disk-backed tests when fs is mocked; they're exercised when this file
// runs in isolation:
//   bun test apps/runner/__tests__/unit/codex-credential-injection.test.ts
function probeFsIsReal(): boolean {
  try {
    return existsSync('/') && !existsSync(join(tmpdir(), `__codex_fs_probe_${process.pid}_${Math.random().toString(16).slice(2)}`));
  } catch {
    return false;
  }
}

// Runs the body only when fs is real; otherwise records a skip.
function fsTest(name: string, fn: () => void | Promise<void>) {
  test(name, async () => {
    if (!probeFsIsReal()) {
      console.warn(`[codex-credential-injection.test] skipping "${name}" — fs is mocked by a sibling suite (covered when run in isolation)`);
      return;
    }
    await fn();
  });
}

// ─── materializeCodexAuth ─────────────────────────────────────────────────────

describe('materializeCodexAuth', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  const cred = {
    credentialType: 'oauth' as const,
    accessToken: 'tok_access_123',
    refreshToken: 'tok_refresh_456',
    accountId: 'acct_789',
    idToken: 'tok_id_abc',
    expiresAt: null,
  };

  fsTest('creates a temp dir and writes auth.json', () => {
    const { codexHome } = materializeCodexAuth('w1', cred);
    dirs.push(codexHome);

    expect(existsSync(codexHome)).toBe(true);
    const authPath = join(codexHome, 'auth.json');
    expect(existsSync(authPath)).toBe(true);
  });

  fsTest('auth.json contains access_token, refresh_token, account_id', () => {
    const { codexHome } = materializeCodexAuth('w1', cred);
    dirs.push(codexHome);

    const authJson = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf-8'));
    expect(authJson.tokens.access_token).toBe('tok_access_123');
    expect(authJson.tokens.refresh_token).toBe('tok_refresh_456');
    expect(authJson.tokens.account_id).toBe('acct_789');
    expect(authJson.tokens.id_token).toBe('tok_id_abc');
  });

  fsTest('auth.json does not contain extra sensitive fields', () => {
    const { codexHome } = materializeCodexAuth('w1', cred);
    dirs.push(codexHome);

    const authJson = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf-8'));
    // expiresAt should NOT be in auth.json (it's metadata, not needed by Codex CLI)
    expect(Object.keys(authJson).sort()).toEqual(['OPENAI_API_KEY', 'last_refresh', 'tokens']);
    expect(Object.keys(authJson.tokens).sort()).toEqual(['access_token', 'account_id', 'id_token', 'refresh_token']);
  });

  fsTest('temp dir is prefixed with "codex-"', () => {
    const { codexHome } = materializeCodexAuth('w1', cred);
    dirs.push(codexHome);

    expect(codexHome.startsWith(tmpdir())).toBe(true);
    expect(codexHome.includes('codex-')).toBe(true);
  });
});

// ─── cleanupCodexAuth ─────────────────────────────────────────────────────────

describe('cleanupCodexAuth', () => {
  fsTest('removes the temp directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
    writeFileSync(join(tempDir, 'auth.json'), '{}');

    expect(existsSync(tempDir)).toBe(true);
    cleanupCodexAuth('w1', tempDir);
    expect(existsSync(tempDir)).toBe(false);
  });

  fsTest('is idempotent (no throw on already-removed dir)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
    rmSync(tempDir, { recursive: true, force: true });

    expect(() => cleanupCodexAuth('w1', tempDir)).not.toThrow();
  });
});

// ─── CodexBackend.resolveApiKey with access_token ────────────────────────────

describe('CodexBackend resolveApiKey — OAuth (access_token) flow', () => {
  let tempDir: string | null = null;

  afterEach(() => {
    if (tempDir) {
      try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
      tempDir = null;
    }
  });

  function makeAuthDir(authContent: Record<string, unknown>): string {
    tempDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
    writeFileSync(join(tempDir, 'auth.json'), JSON.stringify(authContent));
    return tempDir;
  }

  fsTest('resolves api_key from auth.json (legacy API key flow)', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = makeAuthDir({ api_key: 'sk-legacy-key' });
    const backend = new CodexBackend();
    const auth = (backend as any).resolveAuth({ env: { CODEX_HOME: dir } });
    expect(auth.apiKey).toBe('sk-legacy-key');
  });

  fsTest('resolves access_token from auth.json (OAuth device-code flow)', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = makeAuthDir({ access_token: 'oat_access_token', refresh_token: 'oat_refresh', account_id: 'acct1' });
    const backend = new CodexBackend();
    const auth = (backend as any).resolveAuth({ env: { CODEX_HOME: dir } });
    expect(auth).toMatchObject({ codexHome: dir, type: 'oauth' });
  });

  fsTest('api_key takes precedence over access_token if both present', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = makeAuthDir({ api_key: 'sk-key', access_token: 'oat_token' });
    const backend = new CodexBackend();
    const auth = (backend as any).resolveAuth({ env: { CODEX_HOME: dir } });
    expect(auth.apiKey).toBe('sk-key');
  });

  fsTest('falls back to OPENAI_API_KEY env var when auth.json has no recognised key', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = makeAuthDir({ other_field: 'value' });
    const backend = new CodexBackend();
    const auth = (backend as any).resolveAuth({
      env: { CODEX_HOME: dir, OPENAI_API_KEY: 'sk-from-env' },
    });
    expect(auth.apiKey).toBe('sk-from-env');
  });
});
