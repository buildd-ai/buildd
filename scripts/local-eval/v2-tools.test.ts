/**
 * v2-tools: the ingest-time refusal checks, and enriching an already-recorded
 * run.json with its tool-efficiency block from its stored stdout. No model is
 * started by anything here.
 */
import { describe, it, expect } from 'bun:test';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from './lib';
import { enrichRunDir, ingestRefusal, toolEfficiencyOfRun } from './v2-tools';

const line = (o: unknown) => JSON.stringify(o);
const use = (id: string, name: string, input: Record<string, unknown>) => line({ type: 'assistant', message: { content: [{ type: 'tool_use', id, name, input }] } });
const result = (id: string, content: string, isError = false) => line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content, is_error: isError }] } });
const STREAM = [
  use('toolu_1', 'Grep', { pattern: 'applyDiscount' }),
  result('toolu_1', 'src/widget.ts:3:export function applyDiscount'),
  use('toolu_2', 'Grep', { pattern: 'applyDiscount' }),
  result('toolu_2', 'src/widget.ts:3:export function applyDiscount'),
  line({ type: 'result', subtype: 'success', is_error: false, num_turns: 2, result: 'done', usage: { input_tokens: 10, output_tokens: 5 } }),
].join('\n');

const BASE_RECORD = {
  runId: 'r1', suiteId: 'local-v2', suiteVersion: 'v2', scoringVersion: 'score-v2', caseId: 'find-one', trial: 1,
  configId: 'model-x@16384', model: { tag: 'model-x', digest: null, quantization: null }, contextTokens: 16384, promptHash: 'abc',
  harness: { name: 'claude-code', version: null }, runtime: null, startedAt: '2026-11-08T00:00:00Z', endedAt: '2026-11-08T00:05:00Z',
  durationMs: 300000, inputTokens: 10, outputTokens: 5, turns: 2, peakVramMb: null, vramSamples: null,
  result: 'fail', hidden: { ran: true, passed: false }, visible: { ran: false, passed: null }, tampering: [], leaks: [], review: null, harnessNote: null,
  v2: { category: 'find-by-behaviour', split: 'dev', graderId: 'g1', failureClass: 'model' },
};

describe('toolEfficiencyOfRun', () => {
  it('analyses a model harness stream and refuses to analyse a fixture run (no model)', () => {
    expect(toolEfficiencyOfRun('claude-code', STREAM)).not.toBeNull();
    expect(toolEfficiencyOfRun('fixture', STREAM)).toBeNull();
  });
});

describe('ingestRefusal', () => {
  it('sends a clean record', () => {
    expect(ingestRefusal(JSON.stringify(BASE_RECORD))).toBeNull();
  });
  it('refuses a fixture run, a secret-shaped string, invalid JSON and an invalid record', () => {
    expect(ingestRefusal(JSON.stringify({ ...BASE_RECORD, harness: { name: 'fixture', version: null } }))).toContain('fixture');
    expect(ingestRefusal(JSON.stringify({ ...BASE_RECORD, harnessNote: 'leaked sk-live-abcdef1234567890' }))).toContain('secret');
    expect(ingestRefusal('{not json')).toContain('not JSON');
    expect(ingestRefusal(JSON.stringify({ ...BASE_RECORD, harness: undefined }))).toContain('harness');
  });
});

describe('enrichRunDir', () => {
  function withRunDir(setup: (dir: string) => void, fn: (dir: string) => void) {
    const root = tempDir('v2-tools-');
    const runDir = join(root, 'run-1');
    mkdirSync(runDir, { recursive: true });
    setup(runDir);
    try { fn(runDir); } finally { rmSync(root, { recursive: true, force: true }); }
  }

  it('skips a directory with no run.json', () => {
    withRunDir(() => {}, (dir) => {
      const r = enrichRunDir(dir, false);
      expect(r).toMatchObject({ action: 'skipped', runId: null });
    });
  });

  it('adds the bounded block from stored stdout in dry-run, and writes it only with --apply', () => {
    withRunDir((dir) => {
      writeFileSync(join(dir, 'run.json'), JSON.stringify(BASE_RECORD, null, 2));
      writeFileSync(join(dir, 'agent.stdout.txt'), STREAM);
    }, (dir) => {
      const dry = enrichRunDir(dir, false);
      expect(dry.action).toBe('enriched');
      expect(dry.runId).toBe('r1');
      // dry run: run.json on disk is untouched
      expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).toolEfficiency).toBeUndefined();

      const applied = enrichRunDir(dir, true);
      expect(applied.action).toBe('enriched');
      const onDisk = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'));
      expect(onDisk.toolEfficiency.aggregate).toMatchObject({ analyserVersion: 'tea-v1', calls: 2 });
      expect(onDisk.toolEfficiency.source).toBe('claude_stream_json');
      // Idempotent: a second pass is unchanged, not re-enriched.
      const again = enrichRunDir(dir, true);
      expect(again.action).toBe('unchanged');
      expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))).toEqual(onDisk);
    });
  });

  it('never enriches a fixture run, and leaves a run with no stored stdout unknown', () => {
    withRunDir((dir) => {
      writeFileSync(join(dir, 'run.json'), JSON.stringify({ ...BASE_RECORD, harness: { name: 'fixture', version: null } }, null, 2));
      writeFileSync(join(dir, 'agent.stdout.txt'), STREAM);
    }, (dir) => {
      const r = enrichRunDir(dir, true);
      expect(r.action).toBe('skipped');
      expect(r.reason).toContain('fixture');
      expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).toolEfficiency).toBeUndefined();
    });
    withRunDir((dir) => {
      writeFileSync(join(dir, 'run.json'), JSON.stringify(BASE_RECORD, null, 2));
    }, (dir) => {
      const r = enrichRunDir(dir, true);
      expect(r.action).toBe('skipped');
      expect(r.reason).toContain('no stored agent stdout');
    });
  });

  it('a record that already carries a block is left unchanged, not re-derived', () => {
    const already = { ...BASE_RECORD, toolEfficiency: { aggregate: { schemaVersion: 1, analyserVersion: 'tea-v1', harness: 'claude', calls: 1, findingKinds: {}, failureClasses: {}, timing: { observedCalls: 0, totalMs: 0, p50Ms: null, p90Ms: null, maxMs: null }, coverage: { recorded: 1, dropped: 0, unobserved: 0, sampledOut: 0 } }, source: 'claude_stream_json', timing: 'unknown' } };
    withRunDir((dir) => {
      writeFileSync(join(dir, 'run.json'), JSON.stringify(already, null, 2));
      writeFileSync(join(dir, 'agent.stdout.txt'), STREAM);
    }, (dir) => {
      const r = enrichRunDir(dir, true);
      expect(r.action).toBe('unchanged');
      expect(JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8')).toolEfficiency.aggregate.calls).toBe(1);
    });
  });
});
