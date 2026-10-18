/**
 * The login identity a runner reports so the server can key a Claude limit on
 * the login rather than the runner: two runners reading one ~/.claude share
 * one limit. It is a one-way hash of the login's account id, read offline from
 * the CLI's own profile, and never anything derived from a token.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/claude-login-identity.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { claudeLoginIdentity } from '../../src/host-seat';
import { buildTerminalAttributionPayload } from '../../src/terminal-attribution';
import type { LocalWorker } from '../../src/types';

const ACCOUNT = '11111111-2222-4333-8444-555555555555';
const OTHER = '99999999-2222-4333-8444-555555555555';
const login = { claudeAiOauth: { accessToken: 'x'.repeat(20), refreshToken: 'y'.repeat(20) } };
const linux = { platform: 'linux' as const, macKeychainHasLogin: () => false };

function home(opts: { credentials?: unknown; claudeJson?: unknown | string } = {}): string {
  const h = mkdtempSync(join(tmpdir(), 'login-id-'));
  if (opts.credentials !== undefined) {
    mkdirSync(join(h, '.claude'), { recursive: true });
    writeFileSync(join(h, '.claude', '.credentials.json'), JSON.stringify(opts.credentials));
  }
  if (opts.claudeJson !== undefined) {
    writeFileSync(join(h, '.claude.json'), typeof opts.claudeJson === 'string' ? opts.claudeJson : JSON.stringify(opts.claudeJson));
  }
  return h;
}

const profile = (accountUuid: string) => ({ oauthAccount: { accountUuid, organizationUuid: OTHER, emailAddress: 'someone@example.com' } });

describe('claudeLoginIdentity', () => {
  test('is a stable 32-hex hash of the login account id, never the id itself', () => {
    const a = claudeLoginIdentity({ env: {}, home: home({ credentials: login, claudeJson: profile(ACCOUNT) }), ...linux });
    const again = claudeLoginIdentity({ env: {}, home: home({ credentials: login, claudeJson: profile(ACCOUNT) }), ...linux });
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).toBe(again);
    expect(a).not.toContain(ACCOUNT.replace(/-/g, '').slice(0, 8));
  });

  test('differs between logins, and not by organisation: seats in one org have their own limits', () => {
    const a = claudeLoginIdentity({ env: {}, home: home({ credentials: login, claudeJson: profile(ACCOUNT) }), ...linux });
    const b = claudeLoginIdentity({ env: {}, home: home({ credentials: login, claudeJson: profile(OTHER) }), ...linux });
    expect(a).not.toBe(b);
  });

  test('is unknown for a CLAUDE_CODE_OAUTH_TOKEN: the profile on disk may be another account', () => {
    const h = home({ credentials: login, claudeJson: profile(ACCOUNT) });
    expect(claudeLoginIdentity({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake' }, home: h, ...linux })).toBeNull();
  });

  test('is unknown with no login, even when a stub profile is on disk', () => {
    expect(claudeLoginIdentity({ env: {}, home: home({ claudeJson: profile(ACCOUNT) }), ...linux })).toBeNull();
  });

  test('is unknown when the profile is missing, unreadable or not a UUID', () => {
    for (const claudeJson of [undefined, '{not json', {}, { oauthAccount: {} }, { oauthAccount: { accountUuid: 'stub-account' } }]) {
      expect(claudeLoginIdentity({ env: {}, home: home({ credentials: login, claudeJson }), ...linux })).toBeNull();
    }
  });

  test('is unknown when CLAUDE_CONFIG_DIR moves the CLI profile elsewhere', () => {
    const h = home({ credentials: login, claudeJson: profile(ACCOUNT) });
    expect(claudeLoginIdentity({ env: { CLAUDE_CONFIG_DIR: '/elsewhere' }, home: h, ...linux })).toBeNull();
  });
});

describe('terminal report', () => {
  test('sends claudeLoginId when the run recorded one, and omits it otherwise', () => {
    const id = 'a'.repeat(32);
    expect(buildTerminalAttributionPayload({ claudeLoginUsed: 'machine_login', claudeLoginId: id } as LocalWorker).claudeLoginId).toBe(id);
    expect('claudeLoginId' in buildTerminalAttributionPayload({ claudeLoginUsed: 'machine_login' } as LocalWorker)).toBe(false);
  });
});
