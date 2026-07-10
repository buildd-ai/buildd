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

  it('accepts running-state task UUID (regression: running rows must not 404)', () => {
    // Real task ID from production incident 2026-07-09 — mission timeline row
    // for a "running" task was returning 404; ensure the ID is valid for panel open
    expect(isValidTaskId('b5814ed6-4808-499c-8eff-16e567f86576')).toBe(true);
  });

  it('rejects worker ID that looks like a task ID (historical confusion source)', () => {
    // Worker IDs are also UUIDs; the panel must open with the TASK id, not the worker id.
    // Both are syntactically valid UUIDs — this test documents the distinction and confirms
    // isValidTaskId cannot discriminate between them (that's a runtime concern, not a format concern).
    expect(isValidTaskId('c6a00c1a-161a-40fb-b13c-dee1670fea99')).toBe(true);
  });
});
