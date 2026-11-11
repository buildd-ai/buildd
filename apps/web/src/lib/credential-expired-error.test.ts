import { describe, it, expect } from 'bun:test';
import { isCredentialExpiredError } from './budget-errors';
import { isCredentialExpiredError as isNotifyCredentialExpiredError } from './notify-rules';

describe('isCredentialExpiredError', () => {
  it.each([
    'Codex credential expired on 2026-10-10',
    'Your access token has expired. Please log in again.',
    'refresh_token_reused',
    '401 Unauthorized: invalid token',
    'invalid_grant',
  ])('flags %s', (msg) => expect(isCredentialExpiredError(msg)).toBe(true));

  it.each([
    null,
    '',
    'Test suite failed: 3 tests',
    'You have hit your usage limit, resets 11:10am',
    'Merge conflict in src/index.ts',
  ])('ignores %p', (msg) => expect(isCredentialExpiredError(msg as string | null)).toBe(false));
});

describe('provisioning failures are never model-credential failures', () => {
  const notSet =
    'Provision failed: dependency install (registry-auth) at repo root: @acme/private-lib from npm.pkg.github.com refused the credentials (401/403). .npmrc reads the token from $NODE_AUTH_TOKEN, which was not set for the install. Give the worker $NODE_AUTH_TOKEN through its role\'s env';
  const rejected =
    'Provision failed: dependency install (registry-auth) at repo root: @acme/private-lib from npm.pkg.github.com refused the credentials (401/403). .npmrc reads the token from $NODE_AUTH_TOKEN; it was set but rejected — check it is current and can read this package.';
  it.each([
    notSet,
    rejected,
    `${notSet}\nerror: GET https://npm.pkg.github.com/@acme/private-lib - 401`,
    'Provision failed: something with an expired token and invalid_grant',
  ])('ignores %s', (msg) => {
    expect(isCredentialExpiredError(msg)).toBe(false);
    expect(isNotifyCredentialExpiredError(msg)).toBe(false);
  });
  it('still flags a real expired login', () => {
    expect(isNotifyCredentialExpiredError('401 Invalid authentication credentials')).toBe(true);
  });
});
