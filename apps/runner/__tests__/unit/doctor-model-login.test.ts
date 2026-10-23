/**
 * `buildd --doctor` and `buildd status`: one line per agent backend
 * (spec runner-model-login-detect-say-report, R-14 to R-18, AC-15 to AC-19).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { checkClaudeBackend, checkCodexBackend, runDiagnostics } from '../../src/doctor';
import { resolveLaunchedCodexBinary } from '../../src/model-login-report';
import { runStatus, type LauncherContext } from '../../src/launcher-commands';
import { backendLoginLines } from '../../src/model-login-report';
import { NO_CODEX_AUTH_FIX, NO_MODEL_AUTH_FIX } from '../../src/host-seat';
import type { RunnerIsolationRecord } from '@buildd/shared';

const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
const tmp = (p: string) => { const d = mkdtempSync(join(tmpdir(), p)); dirs.push(d); return d; };

const SECRET = 'sk-ant-oat01-DO-NOT-PRINT-0123456789abcdef';
const OPENAI_SECRET = 'sk-openai-DO-NOT-PRINT-0123456789abcdef';

/** A home with a Claude login (credentials file) and optionally a Codex login. */
function home(opts: { claudeLogin?: boolean; codex?: 'chatgpt' | 'api_key' } = {}): string {
  const h = tmp('doctor-home-');
  if (opts.claudeLogin) {
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: SECRET, refreshToken: SECRET } }));
  }
  if (opts.codex) {
    mkdirSync(join(h, '.codex'), { recursive: true });
    writeFileSync(join(h, '.codex', 'auth.json'), JSON.stringify(
      opts.codex === 'chatgpt'
        ? { auth_mode: 'chatgpt', tokens: { access_token: SECRET, refresh_token: SECRET } }
        : { OPENAI_API_KEY: OPENAI_SECRET },
    ));
  }
  return h;
}

const probe = (h: string, env: Record<string, string> = {}) => ({ home: h, env, platform: 'linux' as const, macKeychainHasLogin: () => false });

const full = { mechanism: 'bwrap', scope: ['write', 'network'] } as const;
const fullyConfined: RunnerIsolationRecord = {
  platform: 'linux', evidence: ['process.platform=linux'], claude: { ...full, scope: [...full.scope] },
  codex: { 'workspace-write': { ...full, scope: [...full.scope] }, 'read-only': { ...full, scope: [...full.scope] } },
  probeAt: new Date().toISOString(), processStartedAt: new Date().toISOString(), runnerVersion: 'test',
};

describe('doctor: backend lines', () => {
  test('AC-15: a claude login and no Codex login: Claude ok, Codex not a warning and names codex login', () => {
    const p = probe(home({ claudeLogin: true }));
    const claude = checkClaudeBackend({ probe: p, program: '/bin/claude', isolation: fullyConfined });
    const codex = checkCodexBackend({ probe: p, program: '/bin/codex', isolation: fullyConfined });
    expect(claude.status).toBe('ok');
    expect(claude.message).toContain("uses this machine's Claude login");
    expect(codex.status).toBe('ok');
    expect(codex.message).toContain('codex login');
  });

  test('AC-16: no Claude login: a warning with the three fixes, the same words startup uses', () => {
    const claude = checkClaudeBackend({ probe: probe(home()), program: '/bin/claude', isolation: fullyConfined });
    expect(claude.status).toBe('warn');
    expect(claude.message).toContain(NO_MODEL_AUTH_FIX);
    expect(claude.message).toContain('claude login');
    expect(claude.message).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(claude.message).toContain('ANTHROPIC_API_KEY');
  });

  test('R-15: a missing Claude CLI is an error, a missing bundled Codex binary a warning', () => {
    const p = probe(home({ claudeLogin: true, codex: 'chatgpt' }));
    expect(checkClaudeBackend({ probe: p, program: null, isolation: fullyConfined }).status).toBe('error');
    expect(checkCodexBackend({ probe: p, program: null, isolation: fullyConfined }).status).toBe('warn');
  });

  test('R-14: each line carries the backend\'s sandbox verdict', () => {
    const p = probe(home({ claudeLogin: true }));
    expect(checkClaudeBackend({ probe: p, program: '/bin/claude', isolation: fullyConfined }).message).toContain('Sandbox: Claude');
    expect(checkCodexBackend({ probe: p, program: '/bin/codex', isolation: fullyConfined }).message).toContain('Sandbox: Codex');
  });

  test('runDiagnostics lists Claude then Codex after the sandbox check', () => {
    const names = runDiagnostics({ isolation: fullyConfined }).checks.map((c) => c.name);
    expect(names.indexOf('claude')).toBe(names.indexOf('sandbox') + 1);
    expect(names.indexOf('codex')).toBe(names.indexOf('claude') + 1);
  });

  test('AC-17: a global codex that cannot start does not matter; the bundled binary counts', () => {
    // A `codex` on PATH that is a broken node shim (no Node on a fresh Ubuntu).
    const bin = tmp('doctor-path-');
    const shim = join(bin, 'codex');
    writeFileSync(shim, '#!/usr/bin/env node-that-is-not-installed\n');
    chmodSync(shim, 0o755);
    const prior = process.env.PATH;
    process.env.PATH = `${bin}:${prior}`;
    try {
      const bundled = resolveLaunchedCodexBinary({});
      expect(bundled).not.toBeNull();
      expect(bundled).not.toBe(shim);
      const codex = checkCodexBackend({ probe: probe(home()), isolation: fullyConfined });
      expect(codex.status).toBe('ok');
      expect(codex.message).not.toContain('not found');
    } finally {
      process.env.PATH = prior;
    }
  });

  test('R-14: CODEX_PATH_OVERRIDE is the launched program only when it exists', () => {
    expect(resolveLaunchedCodexBinary({ CODEX_PATH_OVERRIDE: '/nonexistent/codex' })).toBeNull();
  });

  test('AC-18: tokens in the env or in login files appear in no doctor output', () => {
    const h = home({ claudeLogin: true, codex: 'chatgpt' });
    const env = { CLAUDE_CODE_OAUTH_TOKEN: SECRET, ANTHROPIC_API_KEY: SECRET, OPENAI_API_KEY: OPENAI_SECRET };
    const out = JSON.stringify([
      checkClaudeBackend({ probe: probe(h, env), program: '/bin/claude', isolation: fullyConfined }),
      checkCodexBackend({ probe: probe(h, env), program: '/bin/codex', isolation: fullyConfined }),
    ]);
    expect(out).not.toContain(SECRET);
    expect(out).not.toContain(OPENAI_SECRET);
    expect(out).not.toContain('DO-NOT-PRINT');
  });
});

describe('buildd status: backend lines', () => {
  function ctx(): LauncherContext & { lines: string[] } {
    const lines: string[] = [];
    return { home: tmp('status-home-'), cwd: tmp('status-cwd-'), fetch, log: (l) => lines.push(l), error: () => {}, lines };
  }

  test('AC-19: a Claude line and a Codex line, after the buildd login lines, in words', async () => {
    const c = ctx();
    const h = home({ claudeLogin: true, codex: 'api_key' });
    await runStatus(c, () => backendLoginLines(probe(h)).map((l) => l.text));
    const claudeAt = c.lines.findIndex((l) => l.startsWith('Claude: '));
    const codexAt = c.lines.findIndex((l) => l.startsWith('Codex: '));
    expect(c.lines[0]).toMatch(/^Status:/);
    expect(claudeAt).toBeGreaterThan(0);
    expect(codexAt).toBe(claudeAt + 1);
    expect(c.lines[claudeAt]).toContain("this machine's Claude login");
    expect(c.lines[codexAt]).toContain('an OpenAI API key');
  });

  test('a Codex none line names the fix without being an error', async () => {
    const c = ctx();
    await runStatus(c, () => backendLoginLines(probe(home())).map((l) => l.text));
    expect(c.lines.join('\n')).toContain(NO_CODEX_AUTH_FIX);
  });

  test('AC-18: a token in the env appears nowhere in status output', async () => {
    const c = ctx();
    const h = home({ claudeLogin: true, codex: 'chatgpt' });
    const env = { CLAUDE_CODE_OAUTH_TOKEN: SECRET, OPENAI_API_KEY: OPENAI_SECRET };
    await runStatus(c, () => backendLoginLines(probe(h, env)).map((l) => l.text));
    expect(c.lines.join('\n')).not.toContain(SECRET);
    expect(c.lines.join('\n')).not.toContain(OPENAI_SECRET);
  });

  test('without a runner (client mode) status prints just the buildd login lines', async () => {
    const c = ctx();
    await runStatus(c);
    expect(c.lines.some((l) => l.startsWith('Claude:'))).toBe(false);
  });
});
