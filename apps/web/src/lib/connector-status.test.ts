import { describe, it, expect } from 'bun:test';
import {
  deriveConnectorStatus,
  isExpiringSoon,
  shouldNotifyExpiry,
  CONNECTOR_EXPIRY_WARNING_MS,
} from './connector-status';

const NOW = new Date('2026-08-27T12:00:00Z');
const hours = (n: number) => new Date(NOW.getTime() + n * 60 * 60 * 1000);

describe('deriveConnectorStatus', () => {
  it('is not_connected without a credential', () => {
    expect(deriveConnectorStatus(undefined, NOW)).toBe('not_connected');
    expect(deriveConnectorStatus(null, NOW)).toBe('not_connected');
  });

  it('is connected while the token is in the future', () => {
    expect(deriveConnectorStatus({ tokenExpiresAt: hours(1) }, NOW)).toBe('connected');
  });

  it('is expired once the expiry has passed', () => {
    expect(deriveConnectorStatus({ tokenExpiresAt: hours(-1) }, NOW)).toBe('expired');
  });

  it('treats the exact expiry instant as expired', () => {
    expect(deriveConnectorStatus({ tokenExpiresAt: NOW }, NOW)).toBe('expired');
  });

  it('is expired when the refresher nulled the expiry and recorded an error', () => {
    expect(
      deriveConnectorStatus({ tokenExpiresAt: null, lastVerificationError: 'invalid_grant' }, NOW),
    ).toBe('expired');
  });

  it('is connected for a non-expiring credential with no error (header keys)', () => {
    expect(deriveConnectorStatus({ tokenExpiresAt: null }, NOW)).toBe('connected');
  });
});

describe('isExpiringSoon', () => {
  it('flags a token inside the warning window', () => {
    expect(isExpiringSoon({ tokenExpiresAt: hours(3) }, NOW)).toBe(true);
  });

  it('ignores a token beyond the warning window', () => {
    expect(isExpiringSoon({ tokenExpiresAt: hours(48) }, NOW)).toBe(false);
  });

  it('ignores already-expired tokens (that is a different state)', () => {
    expect(isExpiringSoon({ tokenExpiresAt: hours(-1) }, NOW)).toBe(false);
  });

  it('ignores credentials with no expiry at all', () => {
    expect(isExpiringSoon({ tokenExpiresAt: null }, NOW)).toBe(false);
  });

  it('honours a custom window', () => {
    expect(isExpiringSoon({ tokenExpiresAt: hours(3) }, NOW, 60 * 60 * 1000)).toBe(false);
  });

  it('uses a 24h default window', () => {
    expect(CONNECTOR_EXPIRY_WARNING_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('shouldNotifyExpiry', () => {
  it('alerts on a freshly expired credential', () => {
    expect(shouldNotifyExpiry({ tokenExpiresAt: hours(-1) }, NOW)).toBe(true);
  });

  it('alerts ahead of expiry, inside the warning window', () => {
    expect(shouldNotifyExpiry({ tokenExpiresAt: hours(6) }, NOW)).toBe(true);
  });

  it('stays quiet once the team has already been told', () => {
    expect(
      shouldNotifyExpiry({ tokenExpiresAt: hours(-1), expiryNotifiedAt: hours(-0.5) }, NOW),
    ).toBe(false);
  });

  it('stays quiet for a healthy credential', () => {
    expect(shouldNotifyExpiry({ tokenExpiresAt: hours(72) }, NOW)).toBe(false);
  });

  it('stays quiet for a connector nobody ever connected', () => {
    expect(shouldNotifyExpiry(undefined, NOW)).toBe(false);
  });

  it('alerts again after a re-auth clears the dedup stamp', () => {
    // The reconnect path clears expiryNotifiedAt, so a later expiry is a new episode.
    expect(
      shouldNotifyExpiry({ tokenExpiresAt: hours(-1), expiryNotifiedAt: null }, NOW),
    ).toBe(true);
  });
});
