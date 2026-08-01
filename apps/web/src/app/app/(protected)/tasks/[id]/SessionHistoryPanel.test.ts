import { describe, test, expect } from 'bun:test';
import { normalizeMessageContent } from './SessionHistoryPanel';

describe('normalizeMessageContent', () => {
  test('returns [] for null', () => {
    expect(normalizeMessageContent(null)).toEqual([]);
  });

  test('returns [] for undefined', () => {
    expect(normalizeMessageContent(undefined)).toEqual([]);
  });

  test('returns [] for a string (codex may return string content)', () => {
    expect(normalizeMessageContent('some text content')).toEqual([]);
  });

  test('returns [] for non-array objects', () => {
    expect(normalizeMessageContent({})).toEqual([]);
  });

  test('preserves well-formed text parts with non-empty text', () => {
    const content = [{ type: 'text', text: 'hello world' }];
    const result = normalizeMessageContent(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'hello world' });
  });

  test('replaces undefined text with empty string to prevent .length crash', () => {
    const content = [{ type: 'text' }];
    const result = normalizeMessageContent(content);
    expect(result).toHaveLength(1);
    const part = result[0];
    expect(part.type).toBe('text');
    // text must always be a string so .length is safe
    expect(typeof (part as { type: 'text'; text: string }).text).toBe('string');
  });

  test('replaces null text with empty string', () => {
    const content = [{ type: 'text', text: null }];
    const result = normalizeMessageContent(content);
    const part = result[0] as { type: 'text'; text: string };
    expect(typeof part.text).toBe('string');
  });

  test('preserves tool_use parts', () => {
    const content = [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }];
    const result = normalizeMessageContent(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_use');
  });

  test('preserves tool_result parts', () => {
    const content = [{ type: 'tool_result', tool_use_id: 'abc', content: 'output' }];
    const result = normalizeMessageContent(content);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('tool_result');
  });

  test('drops elements that are not objects', () => {
    const content = [null, 42, 'string', { type: 'text', text: 'valid' }];
    const result = normalizeMessageContent(content);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: 'text', text: 'valid' });
  });

  test('mixed content normalizes all parts', () => {
    const content = [
      { type: 'text', text: 'hello' },
      { type: 'text' }, // missing text
      { type: 'tool_use', name: 'Read' },
    ];
    const result = normalizeMessageContent(content);
    expect(result).toHaveLength(3);
    expect((result[1] as { type: 'text'; text: string }).text).toBe('');
  });
});
