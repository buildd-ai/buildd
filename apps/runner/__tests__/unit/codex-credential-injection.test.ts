/**
 * Unit tests for Codex credential injection at spawn time.
 *
 * Verifies:
 * - The temp directory is cleaned up after the worker exits.
 * - CodexBackend.resolveAuth reads api_key / access_token from auth.json.
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

import { cleanupCodexAuth } from '../../src/codex-auth';

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
