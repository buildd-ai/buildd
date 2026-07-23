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

// ── createSecretRedactor ──────────────────────────────────────────────────────

import { createSecretRedactor, redactSecretsInBody } from '../redaction';

describe('createSecretRedactor', () => {
  it('preserves the registered secret label', () => {
    const redact = createSecretRedactor([{ label: 'DISPATCH_API_KEY', value: 'dispatch-secret-value' }]);
    expect(redact('key=dispatch-secret-value')).toBe('key=[REDACTED:DISPATCH_API_KEY]');
  });

  it('redacts common credential shapes without a registered value', () => {
    const redact = createSecretRedactor([]);
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signaturevalue123';
    expect(redact(`Authorization: Bearer ${jwt}`)).toBe('Authorization: [REDACTED:authorization]');
    expect(redact('token=sk-proj-abcdefghijklmnopqrstuvwxyz123456')).toBe('token=[REDACTED:token]');
    expect(redact(`jwt=${jwt}`)).toBe('jwt=[REDACTED:jwt]');
    expect(redact(`hex=${'a1'.repeat(24)}`)).toBe('hex=[REDACTED:credential]');
  });
  it('redacts a single secret value from text', () => {
    const redact = createSecretRedactor(['bld_abc123secretvalue']);
    expect(redact('my key is bld_abc123secretvalue!')).toBe('my key is [REDACTED]!');
  });

  it('redacts multiple secret values', () => {
    const redact = createSecretRedactor(['secret1value', 'secret2value']);
    expect(redact('first=secret1value second=secret2value')).toBe('first=[REDACTED] second=[REDACTED]');
  });

  it('redacts all occurrences in a string', () => {
    const redact = createSecretRedactor(['mysecret']);
    expect(redact('mysecret then again mysecret')).toBe('[REDACTED] then again [REDACTED]');
  });

  it('skips short values (< 8 chars) to avoid false positives', () => {
    const redact = createSecretRedactor(['abc', 'short']);
    expect(redact('value is abc or short here')).toBe('value is abc or short here');
  });

  it('skips empty values', () => {
    const redact = createSecretRedactor(['', '  ']);
    expect(redact('some text')).toBe('some text');
  });

  it('returns identity function when no valid secrets provided', () => {
    const redact = createSecretRedactor([]);
    expect(redact('some text')).toBe('some text');
  });

  it('matches secrets of exactly 8 chars', () => {
    const redact = createSecretRedactor(['12345678']);
    expect(redact('value=12345678!')).toBe('value=[REDACTED]!');
  });

  it('redacts longer secret first when one is a prefix of another', () => {
    const redact = createSecretRedactor(['bld_short123', 'bld_short123extra']);
    // The longer one must be replaced first so 'bld_short123extra' is not left as '[REDACTED]extra'
    const result = redact('key=bld_short123extra or key2=bld_short123');
    expect(result).not.toContain('extra');
    expect(result).toBe('key=[REDACTED] or key2=[REDACTED]');
  });

  it('handles a buildd API key (bld_ + 64 hex chars)', () => {
    const apiKey = 'bld_' + 'a'.repeat(64);
    const redact = createSecretRedactor([apiKey]);
    expect(redact(`Authorization: Bearer ${apiKey}`)).toBe('Authorization: Bearer [REDACTED]');
  });

  it('does not redact unrelated text', () => {
    const redact = createSecretRedactor(['secretvalue12345']);
    expect(redact('this is safe text')).toBe('this is safe text');
  });
});

// ── redactSecretsInBody ───────────────────────────────────────────────────────

describe('redactSecretsInBody', () => {
  const secrets = ['mysupersecretkey'];

  it('redacts from currentAction string field', () => {
    const body = { currentAction: 'Running: printenv mysupersecretkey...' };
    const result = redactSecretsInBody(body, secrets);
    expect(result.currentAction).toBe('Running: printenv [REDACTED]...');
  });

  it('redacts from milestones label', () => {
    const body = { milestones: [{ type: 'action', label: 'Used key mysupersecretkey', ts: 1 }] };
    const result = redactSecretsInBody(body, secrets);
    expect(result.milestones[0].label).toBe('Used key [REDACTED]');
  });

  it('redacts from appendMilestones label', () => {
    const body = { appendMilestones: [{ type: 'status', label: 'Key=mysupersecretkey', ts: 1 }] };
    const result = redactSecretsInBody(body, secrets);
    expect(result.appendMilestones[0].label).toBe('Key=[REDACTED]');
  });

  it('redacts from appendErrorTraces excerpt', () => {
    const body = { appendErrorTraces: [{ pattern: 'git_fatal', excerpt: 'fatal: token mysupersecretkey invalid', source: 'bash' }] };
    const result = redactSecretsInBody(body, secrets);
    expect(result.appendErrorTraces[0].excerpt).toBe('fatal: token [REDACTED] invalid');
  });

  it('redacts from error string', () => {
    const body = { error: 'Auth failed with key mysupersecretkey' };
    const result = redactSecretsInBody(body, secrets);
    expect(result.error).toBe('Auth failed with key [REDACTED]');
  });

  it('redacts from summary string', () => {
    const body = { summary: 'Completed task with token mysupersecretkey' };
    const result = redactSecretsInBody(body, secrets);
    expect(result.summary).toBe('Completed task with token [REDACTED]');
  });

  it('redacts from waitingFor.prompt', () => {
    const body = { waitingFor: { type: 'question', prompt: 'Use key mysupersecretkey to continue' } };
    const result = redactSecretsInBody(body, secrets);
    expect(result.waitingFor.prompt).toBe('Use key [REDACTED] to continue');
  });

  it('returns body unchanged when secrets is empty', () => {
    const body = { currentAction: 'Running: something', error: 'failed' };
    const result = redactSecretsInBody(body, []);
    expect(result).toEqual(body);
  });

  it('returns body unchanged when no secrets appear in it', () => {
    const body = { currentAction: 'Running: ls -la', milestones: [{ label: 'Done', ts: 1 }] };
    const result = redactSecretsInBody(body, secrets);
    expect(result).toEqual(body);
  });

  it('does not mutate the original body', () => {
    const body = { currentAction: 'key: mysupersecretkey' };
    const original = JSON.parse(JSON.stringify(body));
    redactSecretsInBody(body, secrets);
    expect(body).toEqual(original);
  });

  it('recursively redacts tool-call inputs, outputs, transcripts, and progress payloads', () => {
    const body = {
      toolCalls: [{ input: { command: 'echo mysupersecretkey' }, output: 'mysupersecretkey' }],
      transcript: [{ content: [{ type: 'text', text: 'mysupersecretkey' }] }],
      taskProgress: { message: 'using mysupersecretkey' },
    };
    const result = redactSecretsInBody(body, [{ label: 'CUE_SECRET', value: 'mysupersecretkey' }]);
    expect(JSON.stringify(result)).not.toContain('mysupersecretkey');
    expect(result.toolCalls[0].output).toBe('[REDACTED:CUE_SECRET]');
    expect(result.taskProgress.message).toBe('using [REDACTED:CUE_SECRET]');
  });
});
