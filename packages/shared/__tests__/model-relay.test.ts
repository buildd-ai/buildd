// Relay contract and local-runner shapes (docs/specs/local-runner-provider.md
// §3, §5, §6.2): pure validators both the server and the runner lean on.
import { describe, expect, it } from 'bun:test';
import {
  RELAY_DEFAULTS,
  isRetryableRelayError,
  isRelayChatPayload,
  isRelayEmbedPayload,
  isTerminalRelayStatus,
  relayBackoffMs,
  relayPayloadBytes,
  validateChatResult,
  validateEmbedResult,
} from '../src/model-relay';
import {
  LOCAL_MODELS_ADVERT_MAX_MODELS,
  advertisedEmbeddingModels,
  dimensionsForVectorColumn,
  isSupportedEmbeddingDimension,
  parseLocalModelsAdvert,
  parseLocalRunnerConfig,
  vectorColumnForDimensions,
} from '../src/local-runner';

describe('embed result validation (AC-12)', () => {
  const payload = { inputs: ['a', 'b'], inputType: 'document' as const, dimensions: 3 };

  it('accepts one vector of the recorded size per input', () => {
    expect(validateEmbedResult(payload, { vectors: [[1, 2, 3], [0, 0, 1]], dimensions: 3, model: 'm' })).toBeNull();
  });

  it('a vector of another size is dimension_mismatch, never padded or cut', () => {
    const err = validateEmbedResult(payload, { vectors: [[1, 2, 3], [1, 2, 3, 4]], dimensions: 3, model: 'm' });
    expect(err?.code).toBe('dimension_mismatch');
    expect(validateEmbedResult(payload, { vectors: [[1, 2, 3], [1, 2, 3]], dimensions: 1024, model: 'm' })?.code).toBe('dimension_mismatch');
  });

  it('a missing, short or non-finite vector is bad_result', () => {
    expect(validateEmbedResult(payload, null)?.code).toBe('bad_result');
    expect(validateEmbedResult(payload, { vectors: [[1, 2, 3]] })?.code).toBe('bad_result');
    expect(validateEmbedResult(payload, { vectors: [[1, 2, 3], [1, Number.NaN, 3]] })?.code).toBe('bad_result');
    expect(validateEmbedResult(payload, { vectors: [[1, 2, 3], 'x'] })?.code).toBe('bad_result');
  });

  it('chat results need text and a finish reason', () => {
    expect(validateChatResult({ text: 'hi', finishReason: 'stop' })).toBeNull();
    expect(validateChatResult({ text: 'hi' })?.code).toBe('bad_result');
    expect(validateChatResult('hi')?.code).toBe('bad_result');
  });
});

describe('payload guards and limits', () => {
  it('recognises the two payload shapes', () => {
    expect(isRelayEmbedPayload({ inputs: ['a'], inputType: 'query', dimensions: 768 })).toBe(true);
    expect(isRelayEmbedPayload({ inputs: ['a'], inputType: 'query', dimensions: 0 })).toBe(false);
    expect(isRelayEmbedPayload({ inputs: [1], inputType: 'query', dimensions: 768 })).toBe(false);
    expect(isRelayChatPayload({ messages: [] })).toBe(true);
    expect(isRelayChatPayload({ messages: [], options: [] })).toBe(false);
    expect(isRelayChatPayload({})).toBe(false);
  });

  it('measures the payload as JSON bytes against the 1 MB chat cap', () => {
    expect(relayPayloadBytes({ a: 'é' })).toBe(Buffer.byteLength(JSON.stringify({ a: 'é' })));
    expect(RELAY_DEFAULTS.chatPayloadMaxBytes).toBe(1_000_000);
    expect(RELAY_DEFAULTS.maxAttempts).toEqual({ embed: 2, chat: 1 });
  });

  it('backoff doubles per attempt from 5 s and is capped', () => {
    expect(relayBackoffMs(0)).toBe(5_000);
    expect(relayBackoffMs(1)).toBe(10_000);
    expect(relayBackoffMs(3)).toBe(40_000);
    expect(relayBackoffMs(100)).toBe(2 ** 16 * 5_000);
  });

  it('only timeouts and upstream 5xx are retried', () => {
    expect(isRetryableRelayError({ code: 'timeout' })).toBe(true);
    expect(isRetryableRelayError({ code: 'ollama_error', httpStatus: 503 })).toBe(true);
    expect(isRetryableRelayError({ code: 'ollama_error' })).toBe(true);
    expect(isRetryableRelayError({ code: 'ollama_error', httpStatus: 400 })).toBe(false);
    expect(isRetryableRelayError({ code: 'model_missing' })).toBe(false);
    expect(isRetryableRelayError({ code: 'dimension_mismatch' })).toBe(false);
    expect(isRetryableRelayError({ code: 'bad_result' })).toBe(false);
  });

  it('terminal statuses', () => {
    for (const s of ['done', 'failed', 'expired', 'cancelled']) expect(isTerminalRelayStatus(s)).toBe(true);
    for (const s of ['queued', 'leased', 'nope']) expect(isTerminalRelayStatus(s)).toBe(false);
  });
});

describe('vector sizes and columns (spec §5.2)', () => {
  it('768, 1024 and 1536 each have a column; 1024 keeps the original name', () => {
    expect(vectorColumnForDimensions(768)).toBe('embedding_768');
    expect(vectorColumnForDimensions(1024)).toBe('embedding');
    expect(vectorColumnForDimensions(1536)).toBe('embedding_1536');
    expect(dimensionsForVectorColumn('embedding')).toBe(1024);
    expect(dimensionsForVectorColumn('embedding_1536')).toBe(1536);
  });

  it('384 and 4096 are not supported: null, never truncation', () => {
    expect(vectorColumnForDimensions(384)).toBeNull();
    expect(vectorColumnForDimensions(4096)).toBeNull();
    expect(isSupportedEmbeddingDimension(1023)).toBe(false);
    expect(isSupportedEmbeddingDimension('1024')).toBe(false);
  });
});

describe('teams.local_runner config', () => {
  it('reads a pick tolerantly and refuses non-ids and URL-shaped tags', () => {
    const id = '0f3b73a6-4358-487b-8cf4-2992cc467500';
    expect(parseLocalRunnerConfig({ runnerId: id.toUpperCase(), chatModel: 'llama3.1:8b' })).toEqual({ runnerId: id, chatModel: 'llama3.1:8b' });
    expect(parseLocalRunnerConfig({ runnerId: 'not-a-uuid', chatModel: 'http://x/y' })).toEqual({ runnerId: null, chatModel: null });
    expect(parseLocalRunnerConfig(null)).toBeNull();
    expect(parseLocalRunnerConfig([])).toBeNull();
  });
});

describe('localModels advert parser (AC-19, strict)', () => {
  const advert = {
    server: { kind: 'ollama', version: '0.6.2', reachable: true, checkedAt: '2026-11-14T00:00:00Z', url: 'http://127.0.0.1:11434' },
    models: [
      { name: 'nomic-embed-text', family: 'nomic-bert', parameterSize: '137M', capabilities: ['embedding'], dimensions: 768, contextLength: 8192, digest: 'abc' },
      { name: 'llama3.1:8b', capabilities: ['completion', 'bogus'], endpoint: 'http://evil' },
      { name: 'http://evil.example/tag', capabilities: ['embedding'], dimensions: 768 },
      { name: 'x'.repeat(129), capabilities: ['embedding'] },
    ],
    relayStats: { jobs: 12, errors: 1, p50DurationMs: 40.5, p95DurationMs: 210, lastErrorCode: 'timeout', lastErrorAt: '2026-11-14T00:00:00.000Z', token: 'sk-nope' },
    extra: true,
  };

  it('keeps capabilities and dimensions, drops unknown fields, URLs and oversize names', () => {
    const parsed = parseLocalModelsAdvert(advert)!;
    expect(parsed.server).toEqual({ kind: 'ollama', version: '0.6.2', reachable: true, checkedAt: '2026-11-14T00:00:00.000Z' });
    expect(parsed.models.map(m => m.name)).toEqual(['nomic-embed-text', 'llama3.1:8b']);
    expect(parsed.models[0]).toEqual({ name: 'nomic-embed-text', family: 'nomic-bert', parameterSize: '137M', capabilities: ['embedding'], dimensions: 768, contextLength: 8192 });
    expect(parsed.models[1]!.capabilities).toEqual(['completion']);
    expect(parsed.relayStats).toEqual({ jobs: 12, errors: 1, p50DurationMs: 40.5, p95DurationMs: 210, lastErrorCode: 'timeout', lastErrorAt: '2026-11-14T00:00:00.000Z' });
    expect(JSON.stringify(parsed)).not.toContain('://');
    expect(JSON.stringify(parsed)).not.toContain('sk-nope');
  });

  it('is bounded at 50 models and refuses anything that is not an ollama advert', () => {
    const many = { server: { kind: 'ollama', reachable: true }, models: Array.from({ length: 80 }, (_, i) => ({ name: `m${i}`, capabilities: ['completion'] })) };
    expect(parseLocalModelsAdvert(many)!.models).toHaveLength(LOCAL_MODELS_ADVERT_MAX_MODELS);
    expect(parseLocalModelsAdvert({ server: { kind: 'vllm' }, models: [] })).toBeNull();
    expect(parseLocalModelsAdvert('nope')).toBeNull();
    expect(parseLocalModelsAdvert({ server: { kind: 'ollama' } })!.models).toEqual([]);
  });

  it('offers only embedding-capable models and marks unsupported sizes', () => {
    const parsed = parseLocalModelsAdvert({
      server: { kind: 'ollama', reachable: true },
      models: [
        { name: 'nomic-embed-text', capabilities: ['embedding'], dimensions: 768 },
        { name: 'all-minilm', capabilities: ['embedding'], dimensions: 384 },
        { name: 'llama3.1:8b', capabilities: ['completion'] },
      ],
    });
    expect(advertisedEmbeddingModels(parsed)).toEqual([
      { name: 'nomic-embed-text', dimensions: 768, supported: true },
      { name: 'all-minilm', dimensions: 384, supported: false },
    ]);
    expect(advertisedEmbeddingModels(null)).toEqual([]);
  });
});
