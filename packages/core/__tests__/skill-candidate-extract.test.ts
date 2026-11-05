/** Spec "Skill candidates, usage telemetry and retirement" r1: AC-8 (R-9, R-10). */
import { describe, expect, it } from 'bun:test';
import { runCandidateExtraction, EXTRACTOR_DEFAULT_MODE } from '../skill-candidate-extract';

const task = (id: string, steps: string[]) => ({ id, day: '2026-11-01', skeleton: steps });
const S = ['Read', 'Grep', 'Edit', 'Bash'];

describe('skill candidate extractor', () => {
  it('AC-8: defaults to recording: decision records, no candidate row', async () => {
    expect(EXTRACTOR_DEFAULT_MODE).toBe('recording');
    const written: unknown[] = [];
    const records: unknown[] = [];
    await runCandidateExtraction({
      tasks: [task('a', S), task('b', S), task('c', S)],
      callModel: async () => ({ title: 't', whenToUse: 'w', steps: ['Read'] }),
      writeCandidate: async (c: unknown) => { written.push(c); },
      recordDecision: async (d: unknown) => { records.push(d); },
    });
    expect(written).toEqual([]);
    expect(records.length).toBeGreaterThan(0);
  });

  it('AC-8: a cluster under 2 tasks makes no model call', async () => {
    let calls = 0;
    await runCandidateExtraction({
      tasks: [task('a', S)],
      callModel: async () => { calls++; return null; },
      writeCandidate: async () => {}, recordDecision: async () => {},
    });
    expect(calls).toBe(0);
  });
});
