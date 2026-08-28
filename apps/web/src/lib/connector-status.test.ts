import { describe, it, expect } from 'bun:test';
import {
  deriveConnectorStatus,
  needsReconnect,
  shouldNotifyExpiry,
  reconnectGraceMs,
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

describe('reconnectGraceMs', () => {
  it('is one full refresh-sweep cycle', () => {
    // Anything shorter would alert about a credential the sweep has not yet had
    // a chance to renew — the false-alarm case.
    expect(reconnectGraceMs()).toBe(300 * 60_000);
  });
});

describe('needsReconnect', () => {
  const GRACE = reconnectGraceMs();

  it('is false for a connector nobody ever connected', () => {
    expect(needsReconnect(undefined, NOW)).toBe(false);
  });

  it('is false for a healthy credential', () => {
    expect(needsReconnect({ tokenExpiresAt: hours(72) }, NOW)).toBe(false);
  });

  it('is false for a credential merely approaching expiry', () => {
    // The whole point of the retune: an access token nearing expiry with a live
    // refresh token is not a human problem. Cue's tokens live 24h, so warning on
    // "expires within 24h" meant a permanent amber card and a daily false alarm.
    expect(needsReconnect({ tokenExpiresAt: hours(1) }, NOW)).toBe(false);
    expect(needsReconnect({ tokenExpiresAt: hours(23) }, NOW)).toBe(false);
  });

  it('is false immediately after expiry — the sweep gets its cycle first', () => {
    expect(needsReconnect({ tokenExpiresAt: hours(-1) }, NOW)).toBe(false);
  });

  it('is true when refresh has definitively failed', () => {
    expect(
      needsReconnect({ tokenExpiresAt: null, lastVerificationError: 'invalid_grant' }, NOW),
    ).toBe(true);
  });

  it('is true when a full sweep cycle passed and the token is still expired', () => {
    // Catches the failure that actually happened: the sweep never ran at all, so
    // nothing renewed a credential that was perfectly renewable.
    const past = new Date(NOW.getTime() - GRACE - 60_000);
    expect(needsReconnect({ tokenExpiresAt: past }, NOW)).toBe(true);
  });

  it('honours a custom grace window', () => {
    expect(needsReconnect({ tokenExpiresAt: hours(-2) }, NOW, 60 * 60_000)).toBe(true);
    expect(needsReconnect({ tokenExpiresAt: hours(-2) }, NOW, 10 * 60 * 60_000)).toBe(false);
  });
});

describe('shouldNotifyExpiry', () => {
  it('alerts when a reconnect is genuinely needed', () => {
    expect(shouldNotifyExpiry({ tokenExpiresAt: null, lastVerificationError: 'bad' }, NOW)).toBe(true);
  });

  it('stays quiet once the team has already been told', () => {
    expect(
      shouldNotifyExpiry(
        { tokenExpiresAt: null, lastVerificationError: 'bad', expiryNotifiedAt: hours(-0.5) },
        NOW,
      ),
    ).toBe(false);
  });

  it('alerts again after a re-auth clears the dedup stamp', () => {
    expect(
      shouldNotifyExpiry({ tokenExpiresAt: null, lastVerificationError: 'bad', expiryNotifiedAt: null }, NOW),
    ).toBe(true);
  });

  it('never alerts on a credential that does not need a reconnect', () => {
    expect(shouldNotifyExpiry({ tokenExpiresAt: hours(3) }, NOW)).toBe(false);
    expect(shouldNotifyExpiry(undefined, NOW)).toBe(false);
  });
});
