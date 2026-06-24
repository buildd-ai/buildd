import { describe, it, expect } from 'bun:test';
import { isValidTaskId } from '@/lib/task-id';

describe('isValidTaskId — shared task-link guard', () => {
  it('accepts a proper v4 UUID', () => {
    expect(isValidTaskId('bf442fcb-6179-43b3-aa92-2564b1ad24b8')).toBe(true);
  });

  it('accepts uppercase UUID', () => {
    expect(isValidTaskId('BF442FCB-6179-43B3-AA92-2564B1AD24B8')).toBe(true);
  });

  it('rejects zero-padded UUID (the production regression pattern)', () => {
    // Real ID bf442fcb-6179-43b3-aa92-2564b1ad24b8 mangled to this
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

  it('rejects a zero-padded ID with only first segment real', () => {
    expect(isValidTaskId('08e2db98-0000-0000-0000-000000000000')).toBe(false);
  });

  it('accepts multiple distinct real UUIDs', () => {
    expect(isValidTaskId('08e2db98-6f42-423f-9ac7-fb1caff6f06c')).toBe(true);
    expect(isValidTaskId('46e91502-0000-0000-0000-000000000000')).toBe(false);
    expect(isValidTaskId('46e91502-dead-beef-cafe-123456789abc')).toBe(true);
  });
});
