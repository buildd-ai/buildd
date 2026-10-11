import { describe, expect, it } from 'bun:test';
import { buildDecisionDataset, sha256Hex, stableJson } from '../decision-dataset';

/** Invented ledger rows: ids and subjects are made up. */
const KIND = 'buildd.merge_readiness';
const records = [
  { id: 'r2', capability: KIND, subjectId: 'ws#2@b', appliedAnswer: 'needs_human', createdAt: new Date('2026-01-02T00:00:00Z') },
  { id: 'r1', capability: KIND, subjectId: 'ws#1@a', appliedAnswer: 'merge_now', createdAt: new Date('2026-01-01T00:00:00Z') },
  { id: 'x1', capability: 'other_kind', subjectId: null, appliedAnswer: 'yes', createdAt: new Date('2026-01-01T00:00:00Z') },
];
const outcomes = [
  { id: 'o2', decisionRecordId: 'r1', source: 'pr_reverted', label: 'not_reverted', value: null, metadata: null, observedAt: new Date('2026-01-09T00:00:00Z'), recordedAt: new Date('2026-01-09T00:00:00Z') },
  { id: 'o1', decisionRecordId: 'r1', source: 'pr_terminal', label: 'merge_now', value: null, metadata: { confidence: 'high' }, observedAt: new Date('2026-01-02T00:00:00Z'), recordedAt: new Date('2026-01-02T00:00:00Z') },
  { id: 'ox', decisionRecordId: 'x1', source: 'human', label: 'overridden', value: null, metadata: null, observedAt: new Date('2026-01-02T00:00:00Z'), recordedAt: new Date('2026-01-02T00:00:00Z') },
];
const build = (over: Partial<Parameters<typeof buildDecisionDataset>[0]> = {}) => buildDecisionDataset({
  dataset: 'merge-readiness', version: 'v2', kind: KIND, records, outcomes, generatedAt: new Date('2026-01-10T00:00:00Z'), ...over,
});

describe('buildDecisionDataset', () => {
  it('writes the v1 layout: data files, a versioned manifest and a top-level copy', () => {
    const { files } = build();
    expect(files.map(f => f.path)).toEqual([
      'v2/data/records.jsonl', 'v2/data/outcomes.jsonl', 'v2/data/examples.jsonl', 'v2/manifest.json', 'manifest-v2.json',
    ]);
    const byPath = Object.fromEntries(files.map(f => [f.path, f.content]));
    expect(byPath['v2/manifest.json']).toBe(byPath['manifest-v2.json']);
  });

  it('keeps only the kind, sorted by time, and joins labels by source', () => {
    const { files, manifest } = build();
    const lines = (p: string) => files.find(f => f.path === p)!.content.trim().split('\n').map(l => JSON.parse(l));
    expect(lines('v2/data/records.jsonl').map(r => r.id)).toEqual(['r1', 'r2']);
    expect(lines('v2/data/outcomes.jsonl').map(o => o.id)).toEqual(['o1', 'o2']);
    const [first, second] = lines('v2/data/examples.jsonl');
    expect(first.outcomes.pr_terminal.label).toBe('merge_now');
    expect(first.outcomes.pr_reverted.label).toBe('not_reverted');
    expect(second.outcomes).toEqual({});
    expect(manifest.counts).toEqual({ records: 2, outcomes: 2, labelled: 1, bySourceLabel: { pr_terminal: { merge_now: 1 }, pr_reverted: { not_reverted: 1 } } });
  });

  it('the manifest carries each file\'s sha256, bytes and rows', () => {
    const { files, manifest } = build();
    for (const entry of manifest.files) {
      const f = files.find(x => x.path === entry.path)!;
      expect(entry.sha256).toBe(sha256Hex(f.content));
      expect(entry.bytes).toBe(Buffer.byteLength(f.content));
    }
    expect(manifest.files.map(f => f.rows)).toEqual([2, 2, 2]);
  });

  it('is deterministic: input order and key order do not change a hash', () => {
    const a = build().manifest.files;
    const shuffled = build({ records: [...records].reverse().map(r => Object.fromEntries(Object.entries(r).reverse())), outcomes: [...outcomes].reverse() }).manifest.files;
    expect(shuffled).toEqual(a);
  });

  it('refuses a version that is not vN', () => {
    expect(() => build({ version: 'latest' })).toThrow();
  });

  it('stableJson sorts keys and writes dates as ISO', () => {
    expect(stableJson({ b: 1, a: new Date('2026-01-01T00:00:00Z') })).toBe('{"a":"2026-01-01T00:00:00.000Z","b":1}');
  });
});
