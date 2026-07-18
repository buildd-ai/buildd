import { describe, it, expect } from 'bun:test';
import { classifyAuthErrorSeverity, isRevocationClass } from '../auth-error-classifier';

describe('classifyAuthErrorSeverity', () => {
  describe('revoked — explicit credential revocation', () => {
    it('matches "could not be refreshed"', () => {
      expect(classifyAuthErrorSeverity('access token could not be refreshed because you have since logged out')).toBe('revoked');
    });

    it('matches "Please sign in again"', () => {
      expect(classifyAuthErrorSeverity('Please sign in again to continue')).toBe('revoked');
    });

    it('matches invalid_grant', () => {
      expect(classifyAuthErrorSeverity('OAuth error: invalid_grant')).toBe('revoked');
    });

    it('matches "signed in to another account"', () => {
      expect(classifyAuthErrorSeverity('access token could not be refreshed because you signed in to another account')).toBe('revoked');
    });

    it('matches "refresh token is invalid"', () => {
      expect(classifyAuthErrorSeverity('refresh token is invalid or expired')).toBe('revoked');
    });

    it('is case-insensitive', () => {
      expect(classifyAuthErrorSeverity('INVALID_GRANT')).toBe('revoked');
      expect(classifyAuthErrorSeverity('Please Sign In Again')).toBe('revoked');
    });
  });

  describe('degraded — auth failure but not explicit revocation', () => {
    it('matches "Agent authentication failed"', () => {
      expect(classifyAuthErrorSeverity('Agent authentication failed - check API key')).toBe('degraded');
    });

    it('matches "invalid api key"', () => {
      expect(classifyAuthErrorSeverity('invalid api key')).toBe('degraded');
    });

    it('matches "invalid authentication"', () => {
      expect(classifyAuthErrorSeverity('invalid authentication credentials')).toBe('degraded');
    });

    it('matches "authentication failed"', () => {
      expect(classifyAuthErrorSeverity('authentication failed')).toBe('degraded');
    });

    it('matches "401 unauthorized"', () => {
      expect(classifyAuthErrorSeverity('401 unauthorized')).toBe('degraded');
    });

    it('matches "oauth token has expired"', () => {
      expect(classifyAuthErrorSeverity('oauth token has expired')).toBe('degraded');
    });

    it('matches "credential expired"', () => {
      expect(classifyAuthErrorSeverity('credential expired')).toBe('degraded');
    });

    it('matches Codex "No Codex auth found"', () => {
      expect(classifyAuthErrorSeverity('No Codex auth found')).toBe('degraded');
    });
  });

  describe('none — non-auth errors', () => {
    it('returns none for rate limit errors', () => {
      expect(classifyAuthErrorSeverity('rate limit exceeded')).toBe('none');
    });

    it('returns none for budget errors', () => {
      expect(classifyAuthErrorSeverity('budget exhausted')).toBe('none');
    });

    it('returns none for network errors', () => {
      expect(classifyAuthErrorSeverity('ECONNREFUSED')).toBe('none');
    });

    it('returns none for empty string', () => {
      expect(classifyAuthErrorSeverity('')).toBe('none');
    });
  });
});

describe('isRevocationClass', () => {
  it('returns true for revocation-class errors', () => {
    expect(isRevocationClass('access token could not be refreshed')).toBe(true);
    expect(isRevocationClass('invalid_grant')).toBe(true);
  });

  it('returns false for degraded-class errors', () => {
    expect(isRevocationClass('authentication failed')).toBe(false);
    expect(isRevocationClass('invalid api key')).toBe(false);
  });

  it('returns false for non-auth errors', () => {
    expect(isRevocationClass('rate limit exceeded')).toBe(false);
  });
});
