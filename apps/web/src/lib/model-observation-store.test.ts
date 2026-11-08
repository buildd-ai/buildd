/**
 * ingestReplayRuns: a controlled replay run's analysed local tool trace
 * survives validate -> runToObservation -> the stored row, and nothing but the
 * bounded aggregate crosses. The aggregate here is built by the released
 * runner importer and analyser from a Claude Code stream-json transcript, the
 * same path `scripts/local-eval` uses; only the database is stubbed.
 */
import { describe, it, expect, beforeEach, mock } from 'bun:test';
import { replayToolEfficiencyFromStream } from '../../../runner/src/tool-trace-report';

let inserted: any[] = [];
let updates: any[] = [];
mock.module('@buildd/core/db', () => ({
  db: {
    query: { workspaces: { findFirst: async () => ({ teamId: 'team-1' }) } },
    insert: () => ({
      values: (v: any) => ({ onConflictDoUpdate: (o: any) => { inserted.push(v); updates.push(o.set); return Promise.resolve(); } }),
    }),
  },
}));

const { ingestReplayRuns } = await import('./model-observation-store');

const line = (o: unknown) => JSON.stringify(o);
const use = (id: string, name: string, input: Record<string, unknown>) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: string, isError = false) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const SECRET_COMMAND = 'bun test src/widget.test.ts --token=sk-live-abcdef1234567890';
const STREAM = [
  line({ type: 'system', subtype: 'init', cwd: '/home/operator/private-root/tree', tools: ['Read', 'Grep', 'Bash'] }),
  use('toolu_1', 'Grep', { pattern: 'applyDiscount', path: 'src' }),
  result('toolu_1', 'src/widget.ts:3:export function applyDiscount'),
  use('toolu_2', 'Grep', { pattern: 'applyDiscount', path: 'src' }),
  result('toolu_2', 'src/widget.ts:3:export function applyDiscount'),
  use('toolu_3', 'Read', { file_path: '/home/operator/private-root/tree/src/widget.ts' }),
  result('toolu_3', 'export function applyDiscount(total) { return total; }'),
  use('toolu_4', 'Read', { file_path: '/home/operator/private-root/tree/src/widget.ts' }),
  result('toolu_4', 'export function applyDiscount(total) { return total; }'),
  use('toolu_5', 'Bash', { command: SECRET_COMMAND }),
  result('toolu_5', 'error: 1 test failed\nexit code 1', true),
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 6, result: 'I think it is fixed. The claim: all done.', usage: { input_tokens: 900, output_tokens: 80 } }),
].join('\n');

const record = (toolEfficiency: unknown) => ({
  runId: 'v2-run-a', suiteId: 'local-v2', suiteVersion: 'v2', scoringVersion: 'score-v2', caseId: 'find-one', trial: 1,
  configId: 'model-x@16384', model: { tag: 'model-x', digest: null, quantization: null }, contextTokens: 16384, promptHash: 'abc',
  harness: { name: 'claude-code', version: null }, runtime: null, startedAt: '2026-11-08T00:00:00Z', endedAt: '2026-11-08T00:05:00Z',
  durationMs: 300000, inputTokens: 900, outputTokens: 80, turns: 6, peakVramMb: null, vramSamples: null,
  result: 'fail', hidden: { ran: true, passed: false }, visible: { ran: false, passed: null }, tampering: [], leaks: [], review: null, harnessNote: null,
  v2: { category: 'find-by-behaviour', split: 'dev', graderId: 'g1', failureClass: 'model' },
  ...(toolEfficiency === undefined ? {} : { toolEfficiency }),
});

describe('ingestReplayRuns tool efficiency', () => {
  beforeEach(() => { inserted = []; updates = []; });

  it('stores the real replay aggregate from the stream on the row, with provenance on the evaluation', async () => {
    const te = replayToolEfficiencyFromStream(STREAM);
    expect(te).not.toBeNull();
    const res = await ingestReplayRuns('ws-1', [record(te)]);
    expect(res).toEqual({ ingested: ['v2-run-a'], rejected: [] });
    const row = inserted[0];
    expect(row.toolEfficiency).toMatchObject({ schemaVersion: 1, analyserVersion: 'tea-v1', harness: 'claude', calls: 5 });
    expect(row.toolEfficiency.findingKinds.identical_search_unchanged).toBe(1);
    expect(row.toolEfficiency.findingKinds.redundant_read_unchanged).toBe(1);
    // stream-json carries no line timestamps: timing is unknown, never invented as 0 ms.
    expect(row.toolEfficiency.timing).toEqual({ observedCalls: 0, totalMs: 0, p50Ms: null, p90Ms: null, maxMs: null });
    expect(row.evaluation.toolEfficiency).toEqual({ source: 'claude_stream_json', timing: 'unknown', analyserVersion: 'tea-v1' });
    // A re-ingest (enrichment) updates the same row with the aggregate.
    expect(updates[0].toolEfficiency).toEqual(row.toolEfficiency);
    const stored = JSON.stringify({ row, update: updates[0] });
    for (const s of ['sk-live', 'private-root', 'applyDiscount', 'widget', 'claim', 'toolu_', 'callKey', 'fingerprint']) expect(stored).not.toContain(s);
  });

  it('a record without a trace stores null (unknown), and an unknown field refuses the record', async () => {
    const res = await ingestReplayRuns('ws-1', [record(undefined), record({ ...replayToolEfficiencyFromStream(STREAM), excerpt: SECRET_COMMAND })]);
    expect(res.ingested).toEqual(['v2-run-a']);
    expect(res.rejected).toHaveLength(1);
    expect(res.rejected[0].errors.join()).toContain('toolEfficiency.excerpt');
    expect(inserted).toHaveLength(1);
    expect(inserted[0].toolEfficiency).toBeNull();
    expect(inserted[0].unavailable.toolEfficiency).toBeTruthy();
    expect(JSON.stringify(inserted)).not.toContain('sk-live');
  });
});
