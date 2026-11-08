import { describe, expect, test } from 'bun:test';
import {
  EMPTY_EVIDENCE,
  PeakTracker,
  VRAM_SAMPLING,
  applyEvidence,
  buildObservation,
  correctnessOf,
  evidenceColumns,
  endpointKindFrom,
  failureOriginOf,
  parentAttemptOf,
  parseNvidiaSmiMemory,
  safeLabel,
  sanitizeDescriptor,
  type ObservationInput,
} from '../model-observation';

const base: ObservationInput = {
  workerId: 'w1',
  taskId: 't1',
  workspaceId: 'ws',
  teamId: 'team',
  chainId: 't1',
  parentWorkerId: null,
  resolvedModel: 'claude-sonnet-5-5',
  taskClass: 'engineering/normal',
  modelRoute: 'anthropic_api_key',
  startedAt: new Date('2026-01-01T00:00:00Z'),
  endedAt: new Date('2026-01-01T00:05:00Z'),
  durationMs: 300_000,
  inputTokens: 1000,
  outputTokens: 500,
  turns: 12,
  retries: 0,
  status: 'completed',
  exitCause: null,
  costUsd: 0.42,
  costBasis: 'real',
  priced: true,
  descriptor: {},
};

describe('missing metrics (AC-2)', () => {
  test('unsupported metrics are NULL with a reason, cost is not 0', () => {
    const row = buildObservation({ ...base, inputTokens: null, outputTokens: null, costUsd: null, priced: false, resolvedModel: 'local-model' });
    expect(row.peakVramMb).toBeNull();
    expect(row.generationMs).toBeNull();
    expect(row.tokensPerSecond).toBeNull();
    expect(row.costUsd).toBeNull();
    expect(row.modelVersion).toBeNull();
    for (const k of ['peakVramMb', 'generationMs', 'tokensPerSecond', 'costUsd', 'modelVersion', 'quantization', 'inputTokens']) {
      expect(row.unavailable[k]).toBeTruthy();
    }
  });

  test('throughput exists only with generation time and output tokens', () => {
    const row = buildObservation({ ...base, descriptor: { generationMs: 10_000 } });
    expect(row.tokensPerSecond).toBe(50);
    expect(row.unavailable.tokensPerSecond).toBeUndefined();
    expect(buildObservation(base).tokensPerSecond).toBeNull();
  });

  test('a reported zero cost on a priced model is unknown, not free', () => {
    const row = buildObservation({ ...base, costUsd: 0 });
    expect(row.costUsd).toBeNull();
    expect(row.unavailable.costUsd).toBeTruthy();
  });

  test('a known price keeps the cost', () => {
    expect(buildObservation(base).costUsd).toBe(0.42);
  });
});

describe('no secrets stored (AC-7)', () => {
  test('urls, credentials and unknown keys are dropped; kind labels survive', () => {
    const d = sanitizeDescriptor({
      endpointKind: 'local_loopback',
      modelVersion: 'http://user:pass@localhost:11434/api',
      quantization: 'Q4_K_M',
      backend: 'sk-ant-abcdef',
      harnessVersion: '2.1.316',
      baseUrl: 'http://10.0.0.5:8000',
      apiKey: 'sk-live',
      runtime: { os: 'linux', gpu: 'NVIDIA RTX 4090', gpuMemoryMb: 24564, token: 'abc' },
    });
    expect(d.endpointKind).toBe('local_loopback');
    expect(d.quantization).toBe('Q4_K_M');
    expect(d.harnessVersion).toBe('2.1.316');
    expect(d.modelVersion).toBeUndefined();
    expect(d.backend).toBeUndefined();
    expect(JSON.stringify(d)).not.toMatch(/http|sk-|10\.0\.0|token|apiKey|baseUrl/i);
    expect(d.runtime).toEqual({ os: 'linux', gpu: 'NVIDIA RTX 4090', gpuMemoryMb: 24564 });
  });

  test('digests are allowed, bearer-looking text is not', () => {
    expect(safeLabel('sha256:' + 'a'.repeat(64))).toBeTruthy();
    expect(safeLabel('Bearer abc')).toBeNull();
    expect(safeLabel('ghp_xxxxxxxxxxxxxxxx')).toBeNull();
    expect(safeLabel('a'.repeat(200))).toBeNull();
  });

  test('an unknown endpoint kind is rejected', () => {
    expect(sanitizeDescriptor({ endpointKind: 'http://x' }).endpointKind).toBeUndefined();
  });

  test('kind comes from route labels', () => {
    expect(endpointKindFrom({ modelRoute: 'agent_endpoint' })).toBe('team_endpoint');
    expect(endpointKindFrom({ modelRoute: 'oauth_seat', localModel: true })).toBe('local_loopback');
    expect(endpointKindFrom({})).toBe('unknown');
  });
});

describe('platform vs model failure (AC-4)', () => {
  test('auth, budget, infra and sandbox are never the model', () => {
    for (const cause of ['auth_failure', 'budget_limited', 'infra_failure', 'server_refused', 'never_started']) {
      expect(failureOriginOf('failed', cause)).toBe('platform');
    }
    for (const cause of ['silent_start', 'sandbox_mount_gap']) {
      expect(failureOriginOf('failed', cause)).toBe('harness');
    }
  });
  test('only a failed result is the model; unclassified is unknown', () => {
    expect(failureOriginOf('failed', 'code_failure')).toBe('model');
    expect(failureOriginOf('failed', null)).toBe('unknown');
    expect(failureOriginOf('completed', null)).toBe('none');
  });
  test('built row carries the origin', () => {
    expect(buildObservation({ ...base, status: 'failed', exitCause: 'auth_failure' }).failureOrigin).toBe('platform');
    expect(buildObservation({ ...base, status: 'failed', exitCause: 'code_failure' }).failureOrigin).toBe('model');
  });
});

describe('attribution across retry and fallback (AC-3)', () => {
  test('each attempt keeps its own model and links to the previous', () => {
    const t0 = new Date('2026-01-01T00:00:00Z');
    const t1 = new Date('2026-01-01T01:00:00Z');
    const first = buildObservation({ ...base, workerId: 'w1', resolvedModel: 'model-a', startedAt: t0, status: 'failed', exitCause: 'budget_limited' });
    const parent = parentAttemptOf([{ workerId: 'w1', startedAt: t0 }], { workerId: 'w2', startedAt: t1 });
    const second = buildObservation({ ...base, workerId: 'w2', resolvedModel: 'model-b', startedAt: t1, parentWorkerId: parent, retries: 1 });
    expect(first.resolvedModel).toBe('model-a');
    expect(second.resolvedModel).toBe('model-b');
    expect(second.chainId).toBe(first.chainId);
    expect(second.parentWorkerId).toBe('w1');
    expect(first.failureOrigin).toBe('platform');
  });
  test('a first attempt has no parent and ignores itself', () => {
    expect(parentAttemptOf([{ workerId: 'w1', startedAt: null }], { workerId: 'w1', startedAt: null })).toBeNull();
  });
  test('the latest earlier attempt is the parent', () => {
    const p = parentAttemptOf(
      [
        { workerId: 'a', startedAt: new Date(1000) },
        { workerId: 'b', startedAt: new Date(2000) },
        { workerId: 'c', startedAt: new Date(9000) },
      ],
      { workerId: 'd', startedAt: new Date(3000) },
    );
    expect(p).toBe('b');
  });
  test('the attempt number comes from the report, defaulting to 1', () => {
    expect(buildObservation({ ...base, descriptor: { attempt: 3 } }).attempt).toBe(3);
    expect(buildObservation(base).attempt).toBe(1);
  });
});

describe('late outcomes (AC-5)', () => {
  test('completion alone leaves correctness unknown', () => {
    expect(correctnessOf(EMPTY_EVIDENCE)).toBe('unknown');
  });
  test('independent records move it, contradiction wins', () => {
    const merged = applyEvidence(EMPTY_EVIDENCE, { ciState: 'passed' });
    expect(correctnessOf(merged)).toBe('supported');
    const later = applyEvidence(merged, { reviewVerdict: 'changes_requested' });
    expect(correctnessOf(later)).toBe('contradicted');
    expect(later.ciState).toBe('passed');
  });
  test('an unknown patch does not erase known evidence', () => {
    const e = applyEvidence(EMPTY_EVIDENCE, { prOutcome: 'merged' });
    expect(applyEvidence(e, { prOutcome: null }).prOutcome).toBe('merged');
  });
  test('rework and a closed PR contradict', () => {
    expect(correctnessOf(applyEvidence(EMPTY_EVIDENCE, { reworked: true }))).toBe('contradicted');
    expect(correctnessOf(applyEvidence(EMPTY_EVIDENCE, { prOutcome: 'closed' }))).toBe('contradicted');
  });
});

describe('evidence columns', () => {
  test('only carried fields are set; empty patch is a no-op', () => {
    expect(evidenceColumns({ ciState: null, reviewVerdict: null })).toBeNull();
    expect(evidenceColumns({ ciState: 'failed', prOutcome: null })).toEqual({ ciState: 'failed' });
  });
});

describe('bounded VRAM sampling (R-7)', () => {
  test('parses per-GPU memory and sums', () => {
    expect(parseNvidiaSmiMemory('1024\n2048\n')).toBe(3072);
    expect(parseNvidiaSmiMemory('')).toBeNull();
    expect(parseNvidiaSmiMemory('No devices were found')).toBeNull();
  });
  test('tracks the peak and stops at the sample cap', () => {
    const t = new PeakTracker();
    t.record(100); t.record(900); t.record(null); t.record(300);
    expect(t.peak).toBe(900);
    for (let i = 0; i < VRAM_SAMPLING.maxSamples; i++) t.record(1);
    expect(t.record(99999)).toBe(false);
    expect(t.peak).toBe(900);
  });
});
