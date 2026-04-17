import { describe, it, expect } from 'bun:test';
import { classifyTask } from '../task-classifier';

function mockFetch(responseBody: unknown, status = 200): typeof fetch {
  return (async () => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody),
    json: async () => responseBody,
  })) as unknown as typeof fetch;
}

describe('classifyTask', () => {
  it('parses a clean JSON response', async () => {
    const fetcher = mockFetch({
      content: [{
        type: 'text',
        text: JSON.stringify({ kind: 'engineering', complexity: 'complex', reason: 'multi-file refactor' }),
      }],
    });

    const result = await classifyTask({
      title: 'Refactor the auth middleware',
      description: 'Pull apart the single middleware.ts into separate session and token modules',
      apiKey: 'test-key',
      fetcher,
    });

    expect(result.kind).toBe('engineering');
    expect(result.complexity).toBe('complex');
    expect(result.reason).toContain('refactor');
    expect(result.classifiedBy).toBe('classifier');
  });

  it('strips markdown fences', async () => {
    const fetcher = mockFetch({
      content: [{
        type: 'text',
        text: '```json\n{"kind":"writing","complexity":"simple","reason":"short PR description"}\n```',
      }],
    });
    const result = await classifyTask({ title: 'Write PR desc', apiKey: 'k', fetcher });
    expect(result.kind).toBe('writing');
    expect(result.complexity).toBe('simple');
  });

  it('falls back to engineering/normal for invalid values', async () => {
    const fetcher = mockFetch({
      content: [{ type: 'text', text: '{"kind":"cooking","complexity":"spicy"}' }],
    });
    const result = await classifyTask({ title: 't', apiKey: 'k', fetcher });
    expect(result.kind).toBe('engineering');
    expect(result.complexity).toBe('normal');
  });

  it('throws on non-JSON response', async () => {
    const fetcher = mockFetch({
      content: [{ type: 'text', text: 'Sorry, I cannot classify that' }],
    });
    await expect(
      classifyTask({ title: 't', apiKey: 'k', fetcher }),
    ).rejects.toThrow(/could not parse JSON/);
  });

  it('throws on non-2xx API response', async () => {
    const fetcher = mockFetch('rate limited', 429);
    await expect(
      classifyTask({ title: 't', apiKey: 'k', fetcher }),
    ).rejects.toThrow(/Anthropic API 429/);
  });

  it('throws when no API key is available', async () => {
    const originalKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      await expect(classifyTask({ title: 't' })).rejects.toThrow(/no ANTHROPIC_API_KEY/);
    } finally {
      if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey;
    }
  });
});
