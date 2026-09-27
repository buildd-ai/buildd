import { describe, expect, it } from 'bun:test';
import type { CatalogEntry } from '../model-catalog';
import {
  RANKINGS_TOP_N,
  isFresh,
  mapPermaslug,
  parseRankings,
  popularityFor,
  rankingsCacheKey,
  rankingsRequestUrl,
  scoreRankings,
  type ViewScores,
} from '../openrouter-rankings';

function entry(id: string, openRouterId: string, permaslug?: string): CatalogEntry {
  return {
    id, canonicalId: null, openRouterId, permaslug, provider: openRouterId.startsWith('anthropic/') ? 'anthropic' : 'other',
    displayName: id, contextLength: 400_000, created: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
  };
}

const catalog = [
  entry('claude-sonnet-5', 'anthropic/claude-sonnet-5', 'anthropic/claude-sonnet-5-20260630'),
  entry('qwen/qwen3-coder', 'qwen/qwen3-coder', 'qwen/qwen3-coder-480b'),
  entry('deepseek/deepseek-v4', 'deepseek/deepseek-v4'),
];

const body = (rows: Array<[string, string, string]>, asOf = '2026-09-26T02:00:00Z') => ({
  data: rows.map(([date, model_permaslug, total_tokens]) => ({ date, model_permaslug, total_tokens })),
  meta: { as_of: asOf, start_date: '2026-08-30', end_date: '2026-09-26', version: '1' },
});

describe('request', () => {
  it('asks for the trailing 28 days ending yesterday, per view', () => {
    const now = new Date('2026-09-27T04:00:00Z');
    const tool = new URL(rankingsRequestUrl('tool_calling', now));
    expect(tool.searchParams.get('start_date')).toBe('2026-08-30');
    expect(tool.searchParams.get('end_date')).toBe('2026-09-26');
    expect(tool.searchParams.get('modality')).toBe('tool_calling');
    expect(tool.searchParams.get('period')).toBe('day');
    const prog = new URL(rankingsRequestUrl('programming', now));
    expect(prog.searchParams.get('category')).toBe('programming');
    expect(prog.searchParams.has('period')).toBe(false);
    expect(new URL(rankingsRequestUrl('text', now)).searchParams.get('modality')).toBe('text');
  });

  it('caches per team and view', () => {
    expect(rankingsCacheKey('team-1', 'text')).toBe('or-rankings:v1:team-1:text');
  });
});

describe('parseRankings', () => {
  it('reads permaslugs and string token counts', () => {
    const p = parseRankings(body([['2026-09-26', 'qwen/qwen3-coder-480b', '1200']]));
    expect(p?.rows).toEqual([{ date: '2026-09-26', permaslug: 'qwen/qwen3-coder-480b', tokens: 1200 }]);
    expect(p?.asOf).toBe('2026-09-26T02:00:00Z');
  });

  it('rejects a body that is not the dataset', () => {
    expect(parseRankings({ error: 'nope' })).toBeNull();
    expect(parseRankings({ data: [] })).toBeNull();
  });
});

describe('mapPermaslug', () => {
  it('permaslug first, then the OpenRouter id, else unmapped; other never maps', () => {
    expect(mapPermaslug(catalog, 'anthropic/claude-sonnet-5-20260630')).toBe('claude-sonnet-5');
    expect(mapPermaslug(catalog, 'deepseek/deepseek-v4')).toBe('deepseek/deepseek-v4');
    expect(mapPermaslug(catalog, 'mystery/model')).toBeNull();
    expect(mapPermaslug(catalog, 'other')).toBeNull();
  });
});

describe('scoreRankings', () => {
  it('ranks by summed tokens over the window; pctile = 1 − (rank − 1)/50', () => {
    const p = parseRankings(body([
      ['2026-09-25', 'qwen/qwen3-coder-480b', '500'],
      ['2026-09-26', 'qwen/qwen3-coder-480b', '600'],
      ['2026-09-26', 'anthropic/claude-sonnet-5-20260630', '1000'],
      ['2026-09-26', 'mystery/model', '5000'],
      ['2026-09-26', 'other', '999999'],
    ]))!;
    const { view, unmapped } = scoreRankings(p, catalog);
    // mystery (rank 1) is unmapped but keeps its rank; `other` is never ranked.
    expect(unmapped).toBe(1);
    expect(view.scores).toEqual({ 'qwen/qwen3-coder': 1 - 1 / RANKINGS_TOP_N, 'claude-sonnet-5': 1 - 2 / RANKINGS_TOP_N });
  });

  it('a model outside the top 50 scores nothing', () => {
    const rows: Array<[string, string, string]> = Array.from({ length: 50 }, (_, i) => ['2026-09-26', `x/m${i}`, String(1000 - i)]);
    rows.push(['2026-09-26', 'deepseek/deepseek-v4', '1']);
    expect(scoreRankings(parseRankings(body(rows))!, catalog).view.scores).toEqual({});
  });
});

describe('popularityFor', () => {
  const now = new Date('2026-09-27T06:00:00Z');
  const view = (scores: Record<string, number>, asOf = '2026-09-26T02:00:00Z'): ViewScores => ({ asOf, startDate: null, endDate: null, scores });

  it('agent averages tool_calling and programming; a missing model scores 0', () => {
    const r = popularityFor({
      model: 'claude-sonnet-5', surface: 'agent', catalog, now,
      views: { tool_calling: view({ 'claude-sonnet-5': 1 }), programming: view({}) },
    });
    expect(r).toEqual({ pctile: 0.5, views: ['tool_calling', 'programming'], asOf: '2026-09-26T02:00:00Z' });
  });

  it('matches a dated arm model to its undated score', () => {
    const r = popularityFor({ model: 'claude-sonnet-5-20260630', surface: 'chat', catalog, now, views: { text: view({ 'claude-sonnet-5': 0.9 }) } });
    expect(r?.pctile).toBe(0.9);
  });

  it('scores older than 7 days are ignored: the neutral prior', () => {
    const stale = view({ 'claude-sonnet-5': 1 }, '2026-09-18T02:00:00Z');
    expect(isFresh(stale, now)).toBe(false);
    expect(popularityFor({ model: 'claude-sonnet-5', surface: 'chat', catalog, now, views: { text: stale } })).toBeNull();
    expect(popularityFor({ model: 'claude-sonnet-5', surface: 'chat', catalog, now, views: {} })).toBeNull();
  });
});
