import { describe, it, expect } from 'bun:test';
import { mockWorkers } from './fixtures-data';

const VALID_MILESTONE_TYPES = new Set(['phase', 'status', 'checkpoint', 'action']);
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

describe('dev fixtures mock data', () => {
  const entries = Object.entries(mockWorkers);

  it('has at least the four documented states', () => {
    expect(Object.keys(mockWorkers).sort()).toEqual(
      ['completed', 'failed', 'running', 'waiting-input'].sort(),
    );
  });

  for (const [state, worker] of entries) {
    describe(state, () => {
      // Regression: milestones used `timestamp` (not `ts`) and some lacked a
      // `type`, so WorkerActivityTimeline read milestone.ts === undefined and
      // rendered "Invalid Date". Guard the shape the component actually consumes.
      it('milestones have a numeric ts and a valid type', () => {
        for (const m of worker.milestones) {
          expect(typeof m.ts).toBe('number');
          expect(Number.isFinite(m.ts)).toBe(true);
          expect(VALID_MILESTONE_TYPES.has(m.type)).toBe(true);
        }
      });

      // Regression: `new Date(Date.now() - X)` at module scope produced different
      // values on the server vs the client, causing a hydration mismatch. Date
      // fields must be stable ISO strings.
      it('date fields are deterministic ISO strings', () => {
        for (const field of ['startedAt', 'completedAt', 'createdAt', 'updatedAt'] as const) {
          const v = (worker as Record<string, unknown>)[field];
          if (v === null || v === undefined) continue;
          expect(typeof v).toBe('string');
          expect(v as string).toMatch(ISO_RE);
        }
      });
    });
  }

  it('is deterministic across imports (no Date.now/new Date at module scope)', async () => {
    const again = (await import('./fixtures-data')).mockWorkers;
    expect(again['waiting-input'].updatedAt).toBe(mockWorkers['waiting-input'].updatedAt);
    expect(again['running'].milestones[0].ts).toBe(mockWorkers['running'].milestones[0].ts);
  });
});
