import { expect, test } from 'bun:test';
import { sanitizePayload } from '../src/sanitize';

const T0 = Date.UTC(2026, 9, 11, 0, 0, 0);

test('full timestamps are shifted', () => {
  const out = sanitizePayload({ at: '2026-10-11T12:30:00Z' }, T0);
  expect(out.at).toBe('2000-01-01T12:30:00Z');
});

test('e-mail addresses are redacted', () => {
  const out = sanitizePayload({ by: 'a@b.test' }, T0);
  expect(out.by).toBe('user@example.test');
});

// Reported: exports still contain real calendar dates.
test('date-only values do not survive', () => {
  const out = sanitizePayload({ due: '2026-10-13' }, T0);
  expect(JSON.stringify(out)).not.toContain('2026');
  expect(out.due).toBe('2000-01-03');
});
