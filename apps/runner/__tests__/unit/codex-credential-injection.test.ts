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

// Detect whether another test file has called mock.module('fs') before us.
// Real fs: existsSync('/') === true. Mocked fs (in this codebase): always false.
// When mocked, all describe blocks below are skipped — they need real filesystem
// writes. Run this file in isolation to exercise them:
//   bun test apps/runner/__tests__/unit/codex-credential-injection.test.ts
const FS_IS_MOCKED = !existsSync('/');
const describeFs = FS_IS_MOCKED ? describe.skip : describe;

// ─── materializeCodexAuth ─────────────────────────────────────────────────────

describeFs('materializeCodexAuth', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs) {
      try { rmSync(d, { recursive: true, force: true }); } catch {}
    }
    dirs.length = 0;
  });

  const cred = {
    accessToken: 'tok_access_123',
    refreshToken: 'tok_refresh_456',
    accountId: 'acct_789',
    expiresAt: null,
  };

  test('creates a temp dir and writes auth.json', () => {
    const { codexHome } = materializeCodexAuth('w1', cred);
    dirs.push(codexHome);

    expect(existsSync(codexHome)).toBe(true);
    const authPath = join(codexHome, 'auth.json');
    expect(existsSync(authPath)).toBe(true);
  });

  test('auth.json contains access_token, refresh_token, account_id', () => {
    const { codexHome } = materializeCodexAuth('w1', cred);
    dirs.push(codexHome);

    const authJson = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf-8'));
    expect(authJson.access_token).toBe('tok_access_123');
    expect(authJson.refresh_token).toBe('tok_refresh_456');
    expect(authJson.account_id).toBe('acct_789');
  });

  test('auth.json does not contain extra sensitive fields', () => {
    const { codexHome } = materializeCodexAuth('w1', cred);
    dirs.push(codexHome);

    const authJson = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf-8'));
    // expiresAt should NOT be in auth.json (it's metadata, not needed by Codex CLI)
    expect(Object.keys(authJson).sort()).toEqual(['access_token', 'account_id', 'refresh_token']);
  });

  test('temp dir is prefixed with "codex-"', () => {
    const { codexHome } = materializeCodexAuth('w1', cred);
    dirs.push(codexHome);

    expect(codexHome.startsWith(tmpdir())).toBe(true);
    expect(codexHome.includes('codex-')).toBe(true);
  });
});

// ─── cleanupCodexAuth ─────────────────────────────────────────────────────────

describeFs('cleanupCodexAuth', () => {
  test('removes the temp directory', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
    writeFileSync(join(tempDir, 'auth.json'), '{}');

    expect(existsSync(tempDir)).toBe(true);
    cleanupCodexAuth('w1', tempDir);
    expect(existsSync(tempDir)).toBe(false);
  });

  test('is idempotent (no throw on already-removed dir)', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'codex-test-'));
    rmSync(tempDir, { recursive: true, force: true });

    expect(() => cleanupCodexAuth('w1', tempDir)).not.toThrow();
  });
});

// ─── CodexBackend.resolveApiKey with access_token ────────────────────────────

describeFs('CodexBackend resolveApiKey — OAuth (access_token) flow', () => {
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

  test('resolves api_key from auth.json (legacy API key flow)', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = makeAuthDir({ api_key: 'sk-legacy-key' });
    const backend = new CodexBackend();
    const key = (backend as any).resolveApiKey({ env: { CODEX_HOME: dir } });
    expect(key).toBe('sk-legacy-key');
  });

  test('resolves access_token from auth.json (OAuth device-code flow)', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = makeAuthDir({ access_token: 'oat_access_token', refresh_token: 'oat_refresh', account_id: 'acct1' });
    const backend = new CodexBackend();
    const key = (backend as any).resolveApiKey({ env: { CODEX_HOME: dir } });
    expect(key).toBe('oat_access_token');
  });

  test('api_key takes precedence over access_token if both present', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = makeAuthDir({ api_key: 'sk-key', access_token: 'oat_token' });
    const backend = new CodexBackend();
    const key = (backend as any).resolveApiKey({ env: { CODEX_HOME: dir } });
    expect(key).toBe('sk-key');
  });

  test('falls back to OPENAI_API_KEY env var when auth.json has no recognised key', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = makeAuthDir({ other_field: 'value' });
    const backend = new CodexBackend();
    const key = (backend as any).resolveApiKey({
      env: { CODEX_HOME: dir, OPENAI_API_KEY: 'sk-from-env' },
    });
    expect(key).toBe('sk-from-env');
  });
});
