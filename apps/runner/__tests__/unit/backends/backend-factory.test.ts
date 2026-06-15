/**
 * Unit tests for createBackend factory.
 *
 * Verifies that the factory returns the correct backend class based on the
 * 'backend' discriminator string.
 *
 * Run: bun test apps/runner/__tests__/unit/backends/
 */

import { describe, test, expect, mock } from 'bun:test';

// Mock the SDK before any imports that transitively require it
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: mock(() => ({
    streamInput: mock(() => {}),
    [Symbol.asyncIterator]: () => ({ next: async () => ({ value: undefined, done: true }) }),
  })),
}));

import { createBackend, ClaudeBackend, CodexBackend } from '../../../src/backends/index';

describe('createBackend', () => {
  test('returns ClaudeBackend instance for "claude"', () => {
    const backend = createBackend('claude', {
      options: {},
      inputStream: (async function* () {})(),
    });
    expect(backend).toBeInstanceOf(ClaudeBackend);
  });

  test('returns CodexBackend instance for "codex"', () => {
    const backend = createBackend('codex', {});
    expect(backend).toBeInstanceOf(CodexBackend);
  });

  test('"claude" backend is not a CodexBackend', () => {
    const backend = createBackend('claude', {
      options: {},
      inputStream: (async function* () {})(),
    });
    expect(backend).not.toBeInstanceOf(CodexBackend);
  });

  test('"codex" backend is not a ClaudeBackend', () => {
    const backend = createBackend('codex', {});
    expect(backend).not.toBeInstanceOf(ClaudeBackend);
  });

  test('both backends implement runStreamed()', () => {
    const claude = createBackend('claude', {
      options: {},
      inputStream: (async function* () {})(),
    });
    const codex = createBackend('codex', {});

    expect(typeof claude.runStreamed).toBe('function');
    expect(typeof codex.runStreamed).toBe('function');
  });
});
