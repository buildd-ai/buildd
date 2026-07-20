import { describe, it, expect, beforeEach } from 'bun:test';
import {
  PII_PATTERNS,
  FREE_TEXT_FIELDS,
  createRedactionInterceptor,
  activateRedaction,
  deactivateRedaction,
  getRedactionCounts,
  resetRedactionCounts,
  resetActivationState,
} from '../redaction';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeInterceptor() {
  return createRedactionInterceptor();
}

function intercept(interceptor: ReturnType<typeof makeInterceptor>, body: Record<string, unknown>) {
  return JSON.parse(interceptor(JSON.stringify(body), '/api/test'));
}

beforeEach(() => {
  resetRedactionCounts();
  resetActivationState();
});

// ── Activation gate: standard workspace is a no-op ───────────────────────────

describe('standard workspace — interceptor no-op', () => {
  it('returns body unchanged when no sensitive workspace is active', () => {
    const fn = makeInterceptor();
    const body = JSON.stringify({ message: 'user@example.com called about order #ABC-12345' });
    // No activateRedaction() call — count stays 0
    expect(fn(body, '/api/workers/1')).toBe(body);
  });

  it('returns body unchanged for non-JSON input', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const raw = 'not json';
    expect(fn(raw, '/api/test')).toBe(raw);
    deactivateRedaction();
  });
});

// ── Pattern: email ────────────────────────────────────────────────────────────

describe('PII_PATTERNS — email', () => {
  it('redacts an email address in the message field', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: 'Email from alice@example.com received.' });
    expect(result.message).toBe('Email from [REDACTED:email] received.');
    deactivateRedaction();
  });

  it('redacts multiple email addresses', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: 'From bob@foo.io to carol@bar.org' });
    expect(result.message).not.toContain('@');
    deactivateRedaction();
  });
});

// ── Pattern: phone ────────────────────────────────────────────────────────────

describe('PII_PATTERNS — phone', () => {
  it('redacts a NANP phone in (NXX) NXX-XXXX format', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: 'Call (555) 867-5309 for support.' });
    expect(result.message).toBe('Call [REDACTED:phone] for support.');
    deactivateRedaction();
  });

  it('redacts a phone with country code', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { summary: 'Reach us at +1-800-555-1234.' });
    expect(result.summary).toContain('[REDACTED:phone]');
    deactivateRedaction();
  });

  it('redacts an unformatted 10-digit US number', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: 'Number is 5558675309.' });
    expect(result.message).toContain('[REDACTED:phone]');
    deactivateRedaction();
  });
});

// ── Pattern: postal address ───────────────────────────────────────────────────

describe('PII_PATTERNS — postal address', () => {
  it('redacts a street address in the content field', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { content: 'Ship to 123 Main St.' });
    expect(result.content).toContain('[REDACTED:address]');
    deactivateRedaction();
  });

  it('redacts an address with multi-word street name', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { body: 'Deliver to 45 Oak Tree Lane' });
    expect(result.body).toContain('[REDACTED:address]');
    deactivateRedaction();
  });
});

// ── Pattern: UPS tracking ─────────────────────────────────────────────────────

describe('PII_PATTERNS — UPS tracking', () => {
  it('redacts a UPS 1Z tracking number', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: 'Tracking: 1ZA1B2C3D4E5F6G7H8' });
    expect(result.message).toContain('[REDACTED:tracking]');
    deactivateRedaction();
  });
});

// ── Pattern: FedEx tracking ───────────────────────────────────────────────────

describe('PII_PATTERNS — FedEx tracking', () => {
  it('redacts a 15-digit FedEx tracking number', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: 'FedEx: 123456789012345' });
    expect(result.message).toContain('[REDACTED:tracking]');
    deactivateRedaction();
  });

  it('redacts a 20-digit FedEx tracking number', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: 'ID: 12345678901234567890' });
    expect(result.message).toContain('[REDACTED:tracking]');
    deactivateRedaction();
  });

  it('redacts a 22-digit FedEx tracking number', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: '9261290100830049000017' });
    expect(result.message).toContain('[REDACTED:tracking]');
    deactivateRedaction();
  });
});

// ── Pattern: order_ref ────────────────────────────────────────────────────────

describe('PII_PATTERNS — order_ref', () => {
  it('redacts an order reference with alphanumeric ID', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { message: 'For order #ABC-12345 please update' });
    expect(result.message).toContain('[REDACTED:order_ref]');
    deactivateRedaction();
  });

  it('redacts an invoice reference', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { summary: 'Invoice INV-98765 is due' });
    expect(result.summary).toContain('[REDACTED:order_ref]');
    deactivateRedaction();
  });
});

// ── Allowlist: shapes that must survive ───────────────────────────────────────

describe('allowlist shapes survive redaction', () => {
  function assertSurvives(field: string, value: string) {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { [field]: value });
    expect(result[field]).toBe(value);
    deactivateRedaction();
  }

  it('UUID survives (pre-masked before scan)', () => {
    assertSurvives('message', '5323e564-e213-4fea-8e17-c98e7202ae97');
  });

  it('short git SHA (7 chars) survives', () => {
    assertSurvives('message', 'commit a79a97e');
  });

  it('long git SHA (40 chars) survives', () => {
    assertSurvives('message', 'sha a79a97ed1234567890abcdef12345678deadbeef');
  });

  it('PR/issue reference #1310 survives', () => {
    assertSurvives('message', 'see PR #1310 for context');
  });

  it('semver string survives', () => {
    assertSurvives('message', 'released version 1.2.3 today');
  });

  it('port number survives', () => {
    assertSurvives('message', 'server listening on :3000');
  });

  it('hex color survives', () => {
    assertSurvives('message', 'background color is #FF0000');
  });

  it('IP address survives', () => {
    assertSurvives('message', 'server at 192.168.1.1 is healthy');
  });
});

// ── Counter: increments on match ──────────────────────────────────────────────

describe('counters', () => {
  it('increments hit counter for (type, field) on each unique match', () => {
    resetRedactionCounts();
    activateRedaction();
    const fn = makeInterceptor();
    intercept(fn, { message: 'user@example.com and bob@test.org' });
    const counts = getRedactionCounts();
    expect(counts['email:message']).toBeGreaterThanOrEqual(1);
    deactivateRedaction();
  });

  it('increments phone counter on the summary field', () => {
    resetRedactionCounts();
    activateRedaction();
    const fn = makeInterceptor();
    intercept(fn, { summary: 'Contact (800) 555-1234 or (900) 555-9999' });
    const counts = getRedactionCounts();
    expect(counts['phone:summary']).toBeGreaterThanOrEqual(1);
    deactivateRedaction();
  });

  it('does not increment counters when interceptor is inactive', () => {
    resetRedactionCounts();
    const fn = makeInterceptor();
    fn(JSON.stringify({ message: 'user@example.com' }), '/api/test');
    expect(Object.keys(getRedactionCounts()).length).toBe(0);
  });
});

// ── Nested fields: prompt under waitingFor ────────────────────────────────────

describe('nested free-text fields', () => {
  it('redacts prompt nested under waitingFor', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { waitingFor: { type: 'question', prompt: 'Did alice@example.com confirm?' } });
    expect(result.waitingFor.prompt).toContain('[REDACTED:email]');
    deactivateRedaction();
  });

  it('redacts label inside milestones array', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const result = intercept(fn, { milestones: [{ label: 'Processed order #TRACK-99999' }] });
    expect(result.milestones[0].label).toContain('[REDACTED:order_ref]');
    deactivateRedaction();
  });
});

// ── Structural fields are not touched ────────────────────────────────────────

describe('structural fields pass through unchanged', () => {
  it('does not modify id, status, or workerId fields', () => {
    activateRedaction();
    const fn = makeInterceptor();
    const body = { id: 'abc-123', status: 'working', workerId: 'w-456', progress: 50 };
    const result = intercept(fn, body);
    expect(result).toEqual(body);
    deactivateRedaction();
  });
});

// ── FREE_TEXT_FIELDS export ───────────────────────────────────────────────────

describe('FREE_TEXT_FIELDS', () => {
  it('contains the required field names', () => {
    const required = ['message', 'summary', 'content', 'prompt', 'excerpt', 'label', 'body', 'title'];
    for (const f of required) {
      expect(FREE_TEXT_FIELDS.has(f)).toBe(true);
    }
  });
});

// ── PII_PATTERNS export ───────────────────────────────────────────────────────

describe('PII_PATTERNS', () => {
  it('covers email, phone, address, tracking, order_ref types', () => {
    const types = new Set(PII_PATTERNS.map(p => p.type));
    expect(types.has('email')).toBe(true);
    expect(types.has('phone')).toBe(true);
    expect(types.has('address')).toBe(true);
    expect(types.has('tracking')).toBe(true);
    expect(types.has('order_ref')).toBe(true);
  });
});
