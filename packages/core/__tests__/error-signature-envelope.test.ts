import { describe, it, expect } from 'bun:test';
import { normalizeErrorSignature, unwrapApiErrorEnvelope } from '../error-signature';

// Older runners persisted a refused completion PATCH as the thrown api() text,
// `API error: <status> - <json body>`. Newer runners (server-refusal.ts) persist
// the server's prose `error` field instead. Both spellings describe the same
// refusal and must cluster under one signature, or the family splits in the
// ranked failure table and in `get_failure_analytics error=` lookups.

const PROSE = 'Task has no confirmed outcome — call complete_task with a summary';

describe('normalizeErrorSignature: legacy API error envelope', () => {
  it('folds the legacy envelope into the prose signature', () => {
    const legacy = `API error: 400 - ${JSON.stringify({ error: PROSE, gate: 'no_outcome' })}`;
    expect(normalizeErrorSignature(legacy)).toBe(normalizeErrorSignature(PROSE));
  });

  it('folds envelopes regardless of status code', () => {
    const a = `API error: 409 - ${JSON.stringify({ error: PROSE })}`;
    const b = `API error: 422 - ${JSON.stringify({ error: PROSE })}`;
    expect(normalizeErrorSignature(a)).toBe(normalizeErrorSignature(PROSE));
    expect(normalizeErrorSignature(b)).toBe(normalizeErrorSignature(PROSE));
  });

  it('unwraps a pretty-printed (multi-line) JSON body', () => {
    const legacy = `API error: 400 - ${JSON.stringify({ error: PROSE }, null, 2)}`;
    expect(normalizeErrorSignature(legacy)).toBe(normalizeErrorSignature(PROSE));
  });

  it('keeps the original text when the body is not JSON', () => {
    const raw = 'API error: 502 - <html>Bad Gateway</html>';
    expect(normalizeErrorSignature(raw)).toBe('API error: <n> - <html>Bad Gateway</html>');
  });

  it('keeps the original text when the JSON has no string error field', () => {
    const raw = `API error: 400 - ${JSON.stringify({ message: 'nope' })}`;
    expect(normalizeErrorSignature(raw)).toContain('API error: <n> -');
    const empty = `API error: 400 - ${JSON.stringify({ error: '' })}`;
    expect(normalizeErrorSignature(empty)).toContain('API error: <n> -');
  });

  it('does not touch the Claude CLI "API Error:" (capital E) family', () => {
    const cli = 'API Error: Server error mid-response. The response above may be incomplete.';
    expect(normalizeErrorSignature(cli)).toBe(cli);
  });
});

describe('unwrapApiErrorEnvelope', () => {
  it('returns status, raw body and the parsed error string', () => {
    expect(unwrapApiErrorEnvelope('API error: 400 - {"error":"x"}'))
      .toEqual({ status: 400, rawBody: '{"error":"x"}', message: 'x' });
  });

  it('returns null for non-envelope text', () => {
    expect(unwrapApiErrorEnvelope('boom')).toBeNull();
    expect(unwrapApiErrorEnvelope(null)).toBeNull();
  });

  it('returns message null when the body is not JSON with an error string', () => {
    expect(unwrapApiErrorEnvelope('API error: 500 - oops'))
      .toEqual({ status: 500, rawBody: 'oops', message: null });
  });
});
