import { describe, it, expect } from 'bun:test';

// Mirror the same regexes used in TaskPanelWrapper so the test catches drift
const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZERO_PADDED_RE = /^[0-9a-f]{8}-0{4}-0{4}-0{4}-0{12}$/i;

function isValidTaskId(id: string | null | undefined): id is string {
  if (!id) return false;
  if (!FULL_UUID_RE.test(id)) return false;
  if (ZERO_PADDED_RE.test(id)) return false;
  return true;
}

describe('isValidTaskId — mission task-link guard', () => {
  it('accepts a proper v4 UUID', () => {
    expect(isValidTaskId('bf442fcb-6179-43b3-aa92-2564b1ad24b8')).toBe(true);
  });

  it('accepts uppercase UUID', () => {
    expect(isValidTaskId('BF442FCB-6179-43B3-AA92-2564B1AD24B8')).toBe(true);
  });

  it('rejects zero-padded UUID (the production regression pattern)', () => {
    // The exact pattern from the Vercel error log
    expect(isValidTaskId('bf442fcb-0000-0000-0000-000000000000')).toBe(false);
  });

  it('rejects an 8-char short ID', () => {
    expect(isValidTaskId('bf442fcb')).toBe(false);
  });

  it('rejects null', () => {
    expect(isValidTaskId(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidTaskId(undefined)).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidTaskId('')).toBe(false);
  });

  it('rejects a UUID missing dashes', () => {
    expect(isValidTaskId('bf442fcb617943b3aa922564b1ad24b8')).toBe(false);
  });

  it('rejects a string that is too short', () => {
    expect(isValidTaskId('bf442fcb-6179-43b3')).toBe(false);
  });
});
