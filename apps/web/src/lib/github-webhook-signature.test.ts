import { describe, it, expect, afterEach } from 'bun:test';
import { createHmac } from 'crypto';
import { verifyWebhookSignature } from './github';

// Webhook signature verification fails closed: with no secret configured,
// nothing verifies. Environments that receive webhooks must set one.

const ORIGINAL = process.env.GITHUB_APP_WEBHOOK_SECRET;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.GITHUB_APP_WEBHOOK_SECRET;
  else process.env.GITHUB_APP_WEBHOOK_SECRET = ORIGINAL;
});

const sign = (payload: string, secret: string) =>
  `sha256=${createHmac('sha256', secret).update(payload).digest('hex')}`;

describe('verifyWebhookSignature', () => {
  it('rejects every delivery when no secret is configured', async () => {
    delete process.env.GITHUB_APP_WEBHOOK_SECRET;
    expect(await verifyWebhookSignature('{"a":1}', sign('{"a":1}', 'anything'))).toBe(false);
    expect(await verifyWebhookSignature('{"a":1}', '')).toBe(false);
  });

  it('accepts a correctly signed payload', async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-fixture-secret';
    expect(await verifyWebhookSignature('{"a":1}', sign('{"a":1}', 'test-fixture-secret'))).toBe(true);
  });

  it('rejects a payload signed with a different secret', async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-fixture-secret';
    expect(await verifyWebhookSignature('{"a":1}', sign('{"a":1}', 'other'))).toBe(false);
  });

  it('rejects a malformed signature header', async () => {
    process.env.GITHUB_APP_WEBHOOK_SECRET = 'test-fixture-secret';
    expect(await verifyWebhookSignature('{"a":1}', 'sha256=zz')).toBe(false);
  });
});
