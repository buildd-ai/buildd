import { describe, it, expect } from 'bun:test';
import {
  recencyDecay,
  applyRecencyAuthority,
  CORPUS_AUTHORITY,
  HALF_LIFE_DAYS,
} from '../knowledge-store/recency-authority';
import type { QueryResult } from '../knowledge-store/types';

function makeResult(
  id: string,
  corpus: 'memory' | 'code' | 'docs' | 'spec' | 'task' | 'artifact' | 'pr' | 'plan' | 'session',
  score = 0.5,
  sourceTs?: Date | null,
): QueryResult {
  return {
    id,
    namespace: `ws-1:${corpus}`,
    corpus,
    sourceType: corpus,
    sourcePath: null,
    sourceUrl: null,
    content: 'content',
    metadata: sourceTs ? { source_ts: sourceTs.toISOString() } : {},
    score,
  };
}

describe('recencyDecay', () => {
  it('returns 1.0 when sourceTs is null (no penalty)', () => {
    expect(recencyDecay(null, 90)).toBe(1.0);
  });

  it('returns ~1.0 for a chunk with age=0', () => {
    const now = new Date();
    expect(recencyDecay(now, 90)).toBeCloseTo(1.0, 3);
  });

  it('returns ~0.5 at exactly one half-life', () => {
    const halfLife = 90;
    const ts = new Date(Date.now() - halfLife * 24 * 60 * 60 * 1000);
    const decay = recencyDecay(ts, halfLife);
    expect(decay).toBeCloseTo(0.5, 2);
  });

  it('returns ~0.25 at exactly two half-lives', () => {
    const halfLife = 30;
    const ts = new Date(Date.now() - 2 * halfLife * 24 * 60 * 60 * 1000);
    const decay = recencyDecay(ts, halfLife);
    expect(decay).toBeCloseTo(0.25, 2);
  });

  it('returns a value between 0 and 1 for any positive age', () => {
    const ts = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const decay = recencyDecay(ts, 90);
    expect(decay).toBeGreaterThan(0);
    expect(decay).toBeLessThan(1);
  });
});

describe('CORPUS_AUTHORITY', () => {
  it('spec has highest authority (1.0)', () => {
    expect(CORPUS_AUTHORITY.spec).toBe(1.0);
  });

  it('session has lowest authority', () => {
    const min = Math.min(...Object.values(CORPUS_AUTHORITY));
    expect(CORPUS_AUTHORITY.session).toBe(min);
  });

  it('covers all corpus types', () => {
    const corpora = ['memory', 'code', 'docs', 'spec', 'task', 'artifact', 'pr', 'plan', 'session'];
    for (const c of corpora) {
      expect(CORPUS_AUTHORITY[c as keyof typeof CORPUS_AUTHORITY]).toBeGreaterThan(0);
    }
  });
});

describe('HALF_LIFE_DAYS', () => {
  it('spec has the longest half-life (most stable)', () => {
    const max = Math.max(...Object.values(HALF_LIFE_DAYS));
    expect(HALF_LIFE_DAYS.spec).toBe(max);
  });

  it('session has shortest half-life (ephemeral)', () => {
    const min = Math.min(...Object.values(HALF_LIFE_DAYS));
    expect(HALF_LIFE_DAYS.session).toBe(min);
  });
});

describe('applyRecencyAuthority', () => {
  const now = new Date();

  it('multiplies score by authority × recency for each result', () => {
    const recent = makeResult('r1', 'spec', 0.5, now);
    const results = applyRecencyAuthority([recent], now);
    // spec authority=1.0, recency≈1.0 (just created), so score ≈ 0.5
    expect(results[0].score).toBeCloseTo(0.5, 2);
  });

  it('applies corpus authority when source_ts is absent', () => {
    const r = makeResult('r1', 'code', 0.8);
    const results = applyRecencyAuthority([r], now);
    expect(results[0].score).toBeCloseTo(0.8 * CORPUS_AUTHORITY.code, 3);
  });

  it('ranks a recent spec above an old task with the same RRF score', () => {
    const oldTask = makeResult('old', 'task', 0.5, new Date(now.getTime() - 180 * 24 * 60 * 60 * 1000));
    const recentSpec = makeResult('new', 'spec', 0.5, now);
    const results = applyRecencyAuthority([oldTask, recentSpec], now);
    const specResult = results.find(r => r.id === 'new')!;
    const taskResult = results.find(r => r.id === 'old')!;
    expect(specResult.score).toBeGreaterThan(taskResult.score);
  });

  it('returns empty array for empty input', () => {
    expect(applyRecencyAuthority([], now)).toEqual([]);
  });

  it('handles source_ts from metadata.source_ts string field', () => {
    const oneYearAgo = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
    const r = makeResult('r1', 'task', 0.8);
    r.metadata = { source_ts: oneYearAgo.toISOString() };
    const results = applyRecencyAuthority([r], now);
    // 365d age with task half-life=30d → ~12 half-lives → 2^(-12) ≈ 0.000244
    // score = 0.8 * 0.4 * 0.000244 ≈ 0.000078
    expect(results[0].score).toBeLessThan(0.01);
  });
});
