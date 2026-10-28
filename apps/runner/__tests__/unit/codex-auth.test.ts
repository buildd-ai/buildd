/**
 * Tests for Codex auth files:
 * - resolveAuth returns type=oauth for a machine login's auth.json
 * - an API key credential is written as api_key into auth.json
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
  stableCodexHomePath,
  teardownStableCodexHome,
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

// ─── Windows: owner-only DACLs ────────────────────────────────────────────────
// chmod does nothing on Windows. The per-worker CODEX_HOME gets an inheritable
// owner-only DACL (so what the Codex CLI writes or renames in later, including
// a refreshed auth.json, is owner-only too) and auth.json its own.

describe.skipIf(process.platform !== 'win32')('codex auth files on Windows', () => {
  let root: string;
  let prevRoot: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'codex-acl-'));
    prevRoot = process.env.CODEX_HOME_ROOT;
    process.env.CODEX_HOME_ROOT = root;
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.CODEX_HOME_ROOT; else process.env.CODEX_HOME_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  });

  fsTest('writeCodexApiKeyToHome writes an owner-only auth.json', async () => {
    const { expectOwnerOnly, openToAllUsers } = await import('../windows-acl');
    const { writeCodexApiKeyToHome } = await import('../../src/codex-auth');
    openToAllUsers(root);
    const home = join(root, 'apikey');
    mkdirSync(home);
    writeCodexApiKeyToHome(home, 'sk-test-key-123');
    expectOwnerOnly(join(home, 'auth.json'));
  });
});
