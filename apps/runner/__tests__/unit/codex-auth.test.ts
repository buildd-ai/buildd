/**
 * Tests for Codex auth lifecycle:
 * - resolveAuth returns type=oauth for OAuth credentials
 * - API key credential injects OPENAI_API_KEY rather than writing auth.json
 * - seedCodexAuthIfMissing only writes auth.json when it is absent (seed-if-missing)
 * - readCodexAuthJson reads back the current auth.json from the stable home
 * - Preflight rejects an expired credential with a clear error message
 */

import { describe, test, expect, afterEach, beforeEach } from 'bun:test';
import * as fsModule from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

const { existsSync, readFileSync, mkdtempSync, writeFileSync, mkdirSync, rmSync } = fsModule;

// Must be before imports that transitively use the Claude SDK
import { mock } from 'bun:test';
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => ({
    streamInput: () => {},
    supportedModels: async () => [],
    [Symbol.asyncIterator]() { return { async next() { return { value: undefined, done: true }; } }; },
  }),
}));

import {
  materializeStableCodexHome,
  seedCodexAuthIfMissing,
  readCodexAuthJson,
  stableCodexHomePath,
  teardownStableCodexHome,
  writeCodexAuthJson,
} from '../../src/codex-auth';

// Probe so tests skip when fs is mocked by a sibling suite
function probeFsIsReal(): boolean {
  try {
    return existsSync('/') && !existsSync(join(tmpdir(), `__codex_probe_${process.pid}_${Math.random().toString(16).slice(2)}`));
  } catch {
    return false;
  }
}
function fsTest(name: string, fn: () => void | Promise<void>) {
  test(name, async () => {
    if (!probeFsIsReal()) {
      console.warn(`[codex-auth.test] skipping "${name}" — fs is mocked by a sibling suite`);
      return;
    }
    await fn();
  });
}

const oauthCred = {
  credentialType: 'oauth' as const,
  accessToken: 'at_fresh',
  refreshToken: 'rt_fresh',
  accountId: 'acct_123',
  idToken: 'id_fresh',
  expiresAt: new Date(Date.now() + 3600_000), // 1h from now
};

const expiredCred = {
  accessToken: 'at_expired',
  refreshToken: 'rt_expired',
  accountId: 'acct_expired',
  expiresAt: new Date(Date.now() - 60_000), // 1 min ago
};

let root: string | undefined;
let prevRoot: string | undefined;

beforeEach(() => {
  if (!probeFsIsReal()) return;
  prevRoot = process.env.CODEX_HOME_ROOT;
  root = mkdtempSync(join(tmpdir(), 'codex-root-test-'));
  process.env.CODEX_HOME_ROOT = root;
});

afterEach(() => {
  if (root) {
    try { rmSync(root, { recursive: true, force: true }); } catch {}
    root = undefined;
  }
  if (prevRoot === undefined) delete process.env.CODEX_HOME_ROOT;
  else process.env.CODEX_HOME_ROOT = prevRoot;
});

// ─── resolveAuth: OAuth path ──────────────────────────────────────────────────

describe('CodexBackend.resolveAuth — OAuth credentials', () => {
  fsTest('returns type=oauth when auth.json has access_token', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = mkdtempSync(join(tmpdir(), 'codex-test-'));
    try {
      writeFileSync(join(dir, 'auth.json'), JSON.stringify({
        access_token: 'oat_access_123',
        refresh_token: 'oat_refresh_456',
        account_id: 'acct_789',
      }));
      const backend = new CodexBackend();
      const auth = (backend as any).resolveAuth({ env: { CODEX_HOME: dir } });
      expect(auth.type).toBe('oauth');
      expect(auth.codexHome).toBe(dir);
      expect(auth.apiKey).toBeUndefined();
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });

  fsTest('resolveAuth prefers api_key over access_token (API key takes precedence)', async () => {
    const { CodexBackend } = await import('../../src/backends/index');
    const dir = mkdtempSync(join(tmpdir(), 'codex-test-'));
    try {
      writeFileSync(join(dir, 'auth.json'), JSON.stringify({
        api_key: 'sk-preferred-key',
        access_token: 'oat_access_token',
      }));
      const backend = new CodexBackend();
      const auth = (backend as any).resolveAuth({ env: { CODEX_HOME: dir } });
      expect(auth.type).toBe('api_key');
      expect(auth.apiKey).toBe('sk-preferred-key');
    } finally {
      try { rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  });
});

// ─── seedCodexAuthIfMissing ───────────────────────────────────────────────────

describe('seedCodexAuthIfMissing', () => {
  fsTest('writes auth.json when the stable home has none', () => {
    const workerId = 'seed-test-worker-1';
    seedCodexAuthIfMissing(workerId, oauthCred);
    const codexHome = stableCodexHomePath(workerId);
    expect(existsSync(codexHome)).toBe(true);
    const auth = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf-8'));
    // Nested shape required by codex-cli 0.144 (tokens.{...} + id_token).
    expect(auth.tokens.access_token).toBe('at_fresh');
    expect(auth.tokens.refresh_token).toBe('rt_fresh');
    expect(auth.tokens.account_id).toBe('acct_123');
    expect(auth.tokens.id_token).toBe('id_fresh');
  });

  fsTest('does NOT overwrite auth.json when one already exists (seed-if-missing)', () => {
    const workerId = 'seed-test-worker-2';
    // First: write a "CLI-refreshed" auth.json manually
    const { codexHome } = materializeStableCodexHome(workerId, oauthCred);
    const freshContent = JSON.stringify({ access_token: 'at_cli_refreshed', refresh_token: 'rt_cli_refreshed', account_id: 'acct_123' });
    writeFileSync(join(codexHome, 'auth.json'), freshContent);

    // Now call seedCodexAuthIfMissing with DIFFERENT tokens — must not overwrite
    const staleCredential = { ...oauthCred, accessToken: 'at_stale', refreshToken: 'rt_stale' };
    seedCodexAuthIfMissing(workerId, staleCredential);

    const auth = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf-8'));
    expect(auth.access_token).toBe('at_cli_refreshed'); // original preserved
  });

  fsTest('is idempotent when called twice with the same credentials', () => {
    const workerId = 'seed-test-worker-3';
    seedCodexAuthIfMissing(workerId, oauthCred);
    seedCodexAuthIfMissing(workerId, oauthCred); // second call — no-op
    const codexHome = stableCodexHomePath(workerId);
    const auth = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf-8'));
    expect(auth.tokens.access_token).toBe('at_fresh');
  });
});

// ─── readCodexAuthJson ────────────────────────────────────────────────────────

describe('readCodexAuthJson', () => {
  fsTest('returns null when no auth.json exists yet', () => {
    const workerId = 'read-test-worker-none';
    // stable home doesn't exist yet
    const result = readCodexAuthJson(workerId);
    expect(result).toBeNull();
  });

  fsTest('returns the current auth.json content after seeding', () => {
    const workerId = 'read-test-worker-1';
    const { codexHome } = materializeStableCodexHome(workerId, oauthCred);
    // Simulate CLI refreshing the tokens
    const refreshed = { access_token: 'at_refreshed', refresh_token: 'rt_refreshed', account_id: 'acct_123' };
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify(refreshed));

    const result = readCodexAuthJson(workerId);
    expect(result).not.toBeNull();
    expect(result!.access_token).toBe('at_refreshed');
    expect(result!.refresh_token).toBe('rt_refreshed');
    expect(result!.account_id).toBe('acct_123');
  });

  fsTest('returns null when auth.json exists but is not valid JSON', () => {
    const workerId = 'read-test-worker-corrupt';
    const codexHome = stableCodexHomePath(workerId);
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, 'auth.json'), '{not: json}');
    const result = readCodexAuthJson(workerId);
    expect(result).toBeNull();
  });
});

// ─── Preflight expiry check ───────────────────────────────────────────────────

describe('checkCodexCredentialExpiry', () => {
  test('returns null (no error) for a fresh credential with expiresAt in the future', () => {
    const { checkCodexCredentialExpiry } = require('../../src/codex-auth');
    const cred = { ...oauthCred, expiresAt: new Date(Date.now() + 3600_000) };
    expect(checkCodexCredentialExpiry(cred)).toBeNull();
  });

  test('returns an error string when expiresAt is in the past', () => {
    const { checkCodexCredentialExpiry } = require('../../src/codex-auth');
    const cred = { ...expiredCred };
    const msg = checkCodexCredentialExpiry(cred);
    expect(msg).not.toBeNull();
    expect(msg).toContain('acct_expired');
    expect(msg).toContain('expired');
    expect(msg).toContain('Settings');
  });

  test('returns null when expiresAt is null (no expiry metadata)', () => {
    const { checkCodexCredentialExpiry } = require('../../src/codex-auth');
    const cred = { ...oauthCred, expiresAt: null };
    expect(checkCodexCredentialExpiry(cred)).toBeNull();
  });

  test('returns null for API key credential even if expiresAt is null', () => {
    const { checkCodexCredentialExpiry } = require('../../src/codex-auth');
    const cred = { credentialType: 'api_key', apiKey: 'sk-test', expiresAt: null };
    expect(checkCodexCredentialExpiry(cred)).toBeNull();
  });
});

// ─── API key: writeCodexApiKey ────────────────────────────────────────────────

describe('writeCodexApiKeyToHome', () => {
  fsTest('writes api_key to auth.json so resolveAuth returns type=api_key', async () => {
    const { writeCodexApiKeyToHome } = await import('../../src/codex-auth');
    const { CodexBackend } = await import('../../src/backends/index');
    const workerId = 'apikey-test-worker-1';
    const codexHome = stableCodexHomePath(workerId);
    mkdirSync(codexHome, { recursive: true });
    writeCodexApiKeyToHome(codexHome, 'sk-test-key-123');

    const auth = JSON.parse(readFileSync(join(codexHome, 'auth.json'), 'utf-8'));
    expect(auth.api_key).toBe('sk-test-key-123');
    expect(auth.access_token).toBeUndefined();

    // resolveAuth picks it up as api_key type
    const backend = new CodexBackend();
    const resolved = (backend as any).resolveAuth({ env: { CODEX_HOME: codexHome } });
    expect(resolved.type).toBe('api_key');
    expect(resolved.apiKey).toBe('sk-test-key-123');

    teardownStableCodexHome(workerId);
  });
});
