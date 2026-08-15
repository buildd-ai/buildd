import { describe, test, expect } from 'bun:test';
import { buildClaudeCredentialsFile } from '../../src/claude-auth';

// Claude Code reads the credential from `.credentials.json` under the
// `claudeAiOauth` key with camelCase fields. It has no code path that reads a
// top-level snake_case `access_token`, so the previous flat shape was silently
// ignored and every worker on this path died with
// "Not logged in · Please run /login".
describe('buildClaudeCredentialsFile', () => {
  test('nests the credential under claudeAiOauth with camelCase fields', () => {
    const c = buildClaudeCredentialsFile('sk-ant-oat01-example', null) as any;

    expect(c.claudeAiOauth).toBeDefined();
    expect(c.claudeAiOauth.accessToken).toBe('sk-ant-oat01-example');
    expect(c.access_token).toBeUndefined();
    expect(c.claudeAiOauth.access_token).toBeUndefined();
  });

  test('writes expiresAt as epoch milliseconds, not seconds', () => {
    const expiry = new Date('2026-08-15T21:24:23.000Z');
    const c = buildClaudeCredentialsFile('sk-ant-oat01-example', expiry);

    expect(c.claudeAiOauth.expiresAt).toBe(expiry.getTime());
    // Guard the original bug: seconds would be ~1000x smaller.
    expect(c.claudeAiOauth.expiresAt).toBeGreaterThan(1_000_000_000_000);
  });

  // '' is a tombstone the CLI uses to mark a revoked token family; null is what
  // the CLI itself synthesizes when authenticating from CLAUDE_CODE_OAUTH_TOKEN.
  test('omits a usable refreshToken as null, never empty string', () => {
    const c = buildClaudeCredentialsFile('sk-ant-oat01-example', null);

    expect(c.claudeAiOauth.refreshToken).toBeNull();
    expect(c.claudeAiOauth.refreshToken).not.toBe('');
  });

  test('carries a null expiresAt through rather than emitting garbage', () => {
    const c = buildClaudeCredentialsFile('sk-ant-oat01-example', null);
    expect(c.claudeAiOauth.expiresAt).toBeNull();
  });

  test('requests the inference scope', () => {
    const c = buildClaudeCredentialsFile('sk-ant-oat01-example', null);
    expect(c.claudeAiOauth.scopes).toEqual(['user:inference']);
  });

  test('serialises to JSON the CLI can parse back', () => {
    const expiry = new Date('2026-08-15T21:24:23.000Z');
    const round = JSON.parse(JSON.stringify(buildClaudeCredentialsFile('tok', expiry)));

    expect(round.claudeAiOauth.accessToken).toBe('tok');
    expect(round.claudeAiOauth.expiresAt).toBe(expiry.getTime());
  });
});
