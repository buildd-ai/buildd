import { describe, it, expect } from 'bun:test';
import { detectProseGate, GATE_PHRASES } from '../prose-gate';

// Verbatim descriptions from the motivating incidents (mission 6dc41ced)
const INCIDENT_222e9216 =
  'Gated on the spec (b984dedf) merging and on the workspace-scope fix (9bc6ebd6) merging — ' +
  'this task edits the same route files, so it must not run in parallel with them.';
const INCIDENT_ca0b692e = 'Gated on the spec merging.';

describe('detectProseGate', () => {
  describe('incident descriptions → match', () => {
    it('detects gate in task 222e9216 description and extracts task IDs', () => {
      const result = detectProseGate(INCIDENT_222e9216);
      expect(result.phrase).not.toBeNull();
      expect(result.taskIds).toContain('b984dedf');
      expect(result.taskIds).toContain('9bc6ebd6');
    });

    it('detects gate in task ca0b692e description', () => {
      const result = detectProseGate(INCIDENT_ca0b692e);
      expect(result.phrase).not.toBeNull();
    });
  });

  describe('gate phrases', () => {
    it('matches "gated on" (case-insensitive)', () => {
      expect(detectProseGate('This task is Gated on the auth PR merging.').phrase).not.toBeNull();
    });

    it('matches "gates on"', () => {
      expect(detectProseGate('Step 2 gates on step 1 completing.').phrase).not.toBeNull();
    });

    it('matches "depends on"', () => {
      expect(detectProseGate('This feature depends on the schema migration landing.').phrase).not.toBeNull();
    });

    it('matches "must not run in parallel"', () => {
      expect(
        detectProseGate('This task must not run in parallel with the schema migration task.').phrase,
      ).not.toBeNull();
    });

    it('matches "blocked on"', () => {
      expect(detectProseGate('Blocked on abc12345 completing.').phrase).not.toBeNull();
    });

    it('matches "after X merges"', () => {
      expect(detectProseGate('Start this after the spec PR merges.').phrase).not.toBeNull();
    });

    it('matches "once X is merged"', () => {
      expect(detectProseGate('Once the migration is merged, run this task.').phrase).not.toBeNull();
    });

    it('matches "wait for"', () => {
      expect(detectProseGate('Wait for the build to pass before claiming.').phrase).not.toBeNull();
    });
  });

  describe('no gate language → no match', () => {
    it('returns null for a plain feature description', () => {
      const result = detectProseGate('Add pagination to the task list endpoint.');
      expect(result.phrase).toBeNull();
      expect(result.taskIds).toHaveLength(0);
    });

    it('incidental mention of a sibling task without gating language', () => {
      const result = detectProseGate(
        'Implement the new auth flow, similar to what was done in task abc12345.',
      );
      expect(result.phrase).toBeNull();
    });

    it('returns null for an empty string', () => {
      expect(detectProseGate('').phrase).toBeNull();
    });
  });

  describe('task ID extraction', () => {
    it('extracts multiple 8-char hex IDs', () => {
      const result = detectProseGate('Gated on deadbeef and cafebabe completing.');
      expect(result.taskIds).toContain('deadbeef');
      expect(result.taskIds).toContain('cafebabe');
    });

    it('does not extract non-hex tokens', () => {
      const result = detectProseGate('Gated on the ZZZZZZZZ task completing.');
      expect(result.taskIds).toHaveLength(0);
    });

    it('returns empty taskIds when no hex IDs present', () => {
      const result = detectProseGate('Blocked on the deployment finishing.');
      expect(result.taskIds).toHaveLength(0);
    });
  });

  describe('GATE_PHRASES export', () => {
    it('is a non-empty readonly array', () => {
      expect(Array.isArray(GATE_PHRASES)).toBe(true);
      expect(GATE_PHRASES.length).toBeGreaterThan(0);
    });

    it('every entry is a non-blank string', () => {
      for (const phrase of GATE_PHRASES) {
        expect(typeof phrase).toBe('string');
        expect(phrase.trim().length).toBeGreaterThan(0);
      }
    });
  });
});
