/**
 * A Codex / ChatGPT login on the runner's own machine (`codex login`) is used
 * as-is: found at $CODEX_HOME or, with no env var, the user's ~/.codex; linked
 * into the per-worker Codex home so refreshes land in the real file; never
 * overwritten by a server credential; and it beats a stored ChatGPT login only
 * under BUILDD_HOST_SEAT=prefer.
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { decideCodexSeat, localCodexAuthPath, resolveLocalCodexHome } from '../../src/host-seat';
import {
  codexAuthIsMachineLink, linkMachineCodexAuth, seedCodexAuthIfMissing, writeCodexApiKeyToHome, writeCodexAuthJson,
} from '../../src/codex-auth';

const MACHINE_LOGIN = JSON.stringify({ OPENAI_API_KEY: null, tokens: { access_token: 'machine-a', refresh_token: 'machine-r', account_id: 'acct', id_token: 'id' } });

function tmp(prefix: string): string { return mkdtempSync(join(tmpdir(), prefix)); }
function machineHome(): { home: string; authPath: string } {
  const home = tmp('codex-user-');
  mkdirSync(join(home, '.codex'), { recursive: true });
  const authPath = join(home, '.codex', 'auth.json');
  writeFileSync(authPath, MACHINE_LOGIN);
  return { home, authPath };
}

describe('the machine Codex home', () => {
  test('defaults to ~/.codex with no CODEX_HOME', () => {
    expect(resolveLocalCodexHome({}, '/home/u')).toBe('/home/u/.codex');
  });
  test('respects CODEX_HOME when set', () => {
    expect(resolveLocalCodexHome({ CODEX_HOME: '/srv/codex' }, '/home/u')).toBe('/srv/codex');
  });
  test('a plain codex login under ~/.codex is found with no env var', () => {
    const { home, authPath } = machineHome();
    try {
      expect(localCodexAuthPath({}, home)).toBe(authPath);
      expect(localCodexAuthPath({}, tmp('codex-empty-'))).toBeNull();
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});

describe('decideCodexSeat', () => {
  const local = '/home/u/.codex/auth.json';
  test('auto: machine login when nothing is delivered', () => {
    expect(decideCodexSeat({ mode: 'auto', serverCredentialType: null, localAuthPath: local, explicitCodexHome: false })).toBe('machine');
    expect(decideCodexSeat({ mode: 'auto', serverCredentialType: null, localAuthPath: null, explicitCodexHome: false })).toBe('none');
  });
  test('auto: a delivered credential is used as before', () => {
    expect(decideCodexSeat({ mode: 'auto', serverCredentialType: 'oauth', localAuthPath: local, explicitCodexHome: false })).toBe('server');
    expect(decideCodexSeat({ mode: 'auto', serverCredentialType: 'api_key', localAuthPath: local, explicitCodexHome: false })).toBe('server');
  });
  test('prefer: the machine login beats a stored ChatGPT login, not a team API key', () => {
    expect(decideCodexSeat({ mode: 'prefer', serverCredentialType: 'oauth', localAuthPath: local, explicitCodexHome: false })).toBe('machine');
    expect(decideCodexSeat({ mode: 'prefer', serverCredentialType: 'api_key', localAuthPath: local, explicitCodexHome: false })).toBe('server');
  });
  test('off: old behaviour, machine login only through an explicit CODEX_HOME', () => {
    expect(decideCodexSeat({ mode: 'off', serverCredentialType: null, localAuthPath: local, explicitCodexHome: false })).toBe('none');
    expect(decideCodexSeat({ mode: 'off', serverCredentialType: null, localAuthPath: local, explicitCodexHome: true })).toBe('machine');
    expect(decideCodexSeat({ mode: 'off', serverCredentialType: 'oauth', localAuthPath: local, explicitCodexHome: true })).toBe('server');
  });
});

describe('per-worker isolation keeps working, linked to the real login', () => {
  test('auth.json in the worker home links to the machine login; refreshes land in the real file', () => {
    const { home, authPath } = machineHome();
    const workerHome = tmp('codex-worker-');
    try {
      writeFileSync(join(workerHome, 'config.toml'), 'model = "x"\n');
      linkMachineCodexAuth(workerHome, authPath);
      expect(lstatSync(join(workerHome, 'auth.json')).isSymbolicLink()).toBe(true);
      expect(readFileSync(join(workerHome, 'auth.json'), 'utf8')).toBe(MACHINE_LOGIN);
      // The CLI rewrites auth.json in place after a refresh.
      writeFileSync(join(workerHome, 'auth.json'), '{"refreshed":true}');
      expect(readFileSync(authPath, 'utf8')).toBe('{"refreshed":true}');
      // The worker's own config stays per worker.
      expect(existsSync(join(home, '.codex', 'config.toml'))).toBe(false);
      // Idempotent.
      linkMachineCodexAuth(workerHome, authPath);
      expect(codexAuthIsMachineLink(workerHome)).toBe(true);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workerHome, { recursive: true, force: true });
    }
  });

  test('replaces a stale copied auth.json from an earlier run', () => {
    const { home, authPath } = machineHome();
    const workerHome = tmp('codex-worker-');
    try {
      writeFileSync(join(workerHome, 'auth.json'), '{"stale":true}');
      linkMachineCodexAuth(workerHome, authPath);
      expect(readFileSync(join(workerHome, 'auth.json'), 'utf8')).toBe(MACHINE_LOGIN);
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workerHome, { recursive: true, force: true });
    }
  });

  test('does not link a home to itself (CODEX_HOME already the worker home)', () => {
    const { home, authPath } = machineHome();
    try {
      linkMachineCodexAuth(join(home, '.codex'), authPath);
      expect(lstatSync(authPath).isSymbolicLink()).toBe(false);
      expect(readFileSync(authPath, 'utf8')).toBe(MACHINE_LOGIN);
    } finally { rmSync(home, { recursive: true, force: true }); }
  });

  test('a server credential written into a linked home never overwrites the machine login', () => {
    const { home, authPath } = machineHome();
    const workerHome = tmp('codex-worker-');
    try {
      linkMachineCodexAuth(workerHome, authPath);
      writeCodexApiKeyToHome(workerHome, 'sk-team-key');
      expect(readFileSync(authPath, 'utf8')).toBe(MACHINE_LOGIN);
      expect(codexAuthIsMachineLink(workerHome)).toBe(false);

      linkMachineCodexAuth(workerHome, authPath);
      writeCodexAuthJson(workerHome, { credentialType: 'oauth', accessToken: 'srv-a', refreshToken: 'srv-r', accountId: 'a', idToken: 'i', expiresAt: null } as any);
      expect(readFileSync(authPath, 'utf8')).toBe(MACHINE_LOGIN);

      linkMachineCodexAuth(workerHome, authPath);
      seedCodexAuthIfMissing('w-link', { credentialType: 'oauth', accessToken: 'srv-a', refreshToken: 'srv-r', accountId: 'a', idToken: 'i', expiresAt: null } as any, workerHome);
      expect(readFileSync(authPath, 'utf8')).toBe(MACHINE_LOGIN);
      expect(JSON.parse(readFileSync(join(workerHome, 'auth.json'), 'utf8')).tokens.access_token).toBe('srv-a');
    } finally {
      rmSync(home, { recursive: true, force: true });
      rmSync(workerHome, { recursive: true, force: true });
    }
  });
});
