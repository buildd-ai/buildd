import { describe, it, expect, mock } from 'bun:test';

mock.module('@buildd/core/db', () => ({ db: {} }));

const { credentialRefOf } = await import('./store');

describe('credentialRefOf', () => {
  it('an unlabelled token answers to the provider name', () => {
    expect(credentialRefOf(null, 'cloudflare')).toBe('cloudflare');
    expect(credentialRefOf('  ', 'cloudflare')).toBe('cloudflare');
  });

  it('the label the Settings form writes counts as unlabelled', () => {
    expect(credentialRefOf('Cloudflare API token', 'cloudflare')).toBe('cloudflare');
  });

  it('a chosen label becomes a slug a request can name', () => {
    expect(credentialRefOf('cloudflare-prod', 'cloudflare')).toBe('cloudflare-prod');
    expect(credentialRefOf('Cloudflare Prod', 'cloudflare')).toBe('cloudflare-prod');
    expect(credentialRefOf('  Staging / EU ', 'cloudflare')).toBe('staging-eu');
  });
});
