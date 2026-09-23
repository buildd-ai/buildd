import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendEvidence,
  EMPTY_STATE,
  evidenceFileName,
  loadState,
  pruneSamples,
  readEvidence,
  recordSample,
  saveState,
} from './evidence';
import type { ClaimSample } from './types';

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'responder-evidence-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sample(at: string): ClaimSample {
  return { at, status: 400, latencyMs: 150, transport: 'responded' };
}

describe('evidence is local, embedded and append-only', () => {
  test('creates its directory on first write rather than throwing', () => {
    const nested = join(dir, 'a', 'b', 'c');
    appendEvidence(nested, { kind: 'cleared', at: '2026-01-02T00:00:00.000Z', conditionKey: 'x', pagedSince: null });
    expect(readdirSync(nested).length).toBe(1);
  });

  test('appends — a second write never truncates the first', () => {
    const at = '2026-01-02T00:00:00.000Z';
    appendEvidence(dir, { kind: 'cleared', at, conditionKey: 'first', pagedSince: null });
    appendEvidence(dir, { kind: 'cleared', at, conditionKey: 'second', pagedSince: null });
    const records = readEvidence(dir, evidenceFileName(at));
    expect(records.map(r => (r as { conditionKey: string }).conditionKey)).toEqual([
      'first',
      'second',
    ]);
  });

  test('one JSON object per line, so a truncated tail loses one record and not the file', () => {
    const at = '2026-01-02T00:00:00.000Z';
    appendEvidence(dir, { kind: 'cleared', at, conditionKey: 'a', pagedSince: null });
    appendEvidence(dir, { kind: 'cleared', at, conditionKey: 'b', pagedSince: null });
    const raw = readFileSync(join(dir, evidenceFileName(at)), 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
  });

  test('rotates by UTC day', () => {
    expect(evidenceFileName('2026-01-02T23:59:59.000Z')).toBe('evidence-2026-01-02.jsonl');
    expect(evidenceFileName('2026-01-03T00:00:01.000Z')).toBe('evidence-2026-01-03.jsonl');
  });

  test('a corrupt line is skipped, not fatal', () => {
    const name = evidenceFileName('2026-01-02T00:00:00.000Z');
    writeFileSync(join(dir, name), '{"kind":"cleared"}\nnot json\n{"kind":"notified"}\n');
    expect(readEvidence(dir, name).map(r => r.kind)).toEqual(['cleared', 'notified']);
  });
});

describe('state', () => {
  test('a missing state file reads as empty rather than throwing', () => {
    expect(loadState(dir)).toEqual(EMPTY_STATE);
  });

  test('round-trips notification windows and samples', () => {
    const state = {
      ...EMPTY_STATE,
      notified: {
        'dispatch-stall': {
          firstNotifiedAt: '2026-01-02T00:00:00.000Z',
          lastNotifiedAt: '2026-01-02T00:00:00.000Z',
          onsetAt: '2026-01-01T22:00:00.000Z',
          pageCount: 1,
        },
      },
      samples: [sample('2026-01-02T00:00:00.000Z')],
    };
    saveState(dir, state);
    expect(loadState(dir)).toEqual(state);
  });

  test('a corrupt state file reads as empty — a responder must still start', () => {
    writeFileSync(join(dir, 'state.json'), '{ this is not json');
    expect(loadState(dir)).toEqual(EMPTY_STATE);
  });

  test('the write is atomic — no temp file is left behind', () => {
    saveState(dir, EMPTY_STATE);
    expect(readdirSync(dir)).toEqual(['state.json']);
  });
});

describe('sample retention', () => {
  const now = Date.parse('2026-01-02T12:00:00.000Z');

  test('drops samples older than the retention window', () => {
    const kept = sample('2026-01-02T11:00:00.000Z');
    const dropped = sample('2026-01-02T05:00:00.000Z');
    expect(pruneSamples([dropped, kept], now, 6)).toEqual([kept]);
  });

  test('keeps samples oldest-first so detectors can walk them', () => {
    const a = sample('2026-01-02T10:00:00.000Z');
    const b = sample('2026-01-02T11:00:00.000Z');
    expect(pruneSamples([b, a], now, 6).map(s => s.at)).toEqual([a.at, b.at]);
  });

  test('recordSample appends and prunes in one step', () => {
    const state = {
      ...EMPTY_STATE,
      samples: [sample('2026-01-02T01:00:00.000Z'), sample('2026-01-02T11:00:00.000Z')],
    };
    const next = recordSample(state, sample('2026-01-02T11:59:00.000Z'), now, 6);
    expect(next.samples.map(s => s.at)).toEqual([
      '2026-01-02T11:00:00.000Z',
      '2026-01-02T11:59:00.000Z',
    ]);
    // The original is untouched: state transitions are values, not mutations,
    // so a crash mid-cycle cannot leave a half-updated object on disk.
    expect(state.samples).toHaveLength(2);
  });

  test('samplingSince survives pruning — it is how a detector tells cold start from broken', () => {
    const state = { ...EMPTY_STATE, samplingSince: '2026-01-01T00:00:00.000Z' };
    const next = recordSample(state, sample('2026-01-02T11:59:00.000Z'), now, 6);
    expect(next.samplingSince).toBe('2026-01-01T00:00:00.000Z');
  });

  test('samplingSince is set from the first sample ever recorded', () => {
    const next = recordSample(EMPTY_STATE, sample('2026-01-02T11:59:00.000Z'), now, 6);
    expect(next.samplingSince).toBe('2026-01-02T11:59:00.000Z');
  });
});
