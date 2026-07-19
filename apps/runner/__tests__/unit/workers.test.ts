/**
 * Unit tests for MessageStream and buildUserMessage helpers
 *
 * These test internal utilities used by WorkerManager for multi-turn
 * conversations with the Claude Agent SDK query() API.
 *
 * Run: bun test __tests__/unit
 */

import { describe, test, it, expect } from 'bun:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildRetryContinuitySection } from '../../src/workers';

// MessageStream: Async queue for multi-turn message passing
// Mirrors implementation in workers.ts
class MessageStream implements AsyncIterable<SDKUserMessage> {
  private queue: SDKUserMessage[] = [];
  private resolvers: Array<(result: IteratorResult<SDKUserMessage>) => void> = [];
  private done = false;

  enqueue(message: SDKUserMessage) {
    if (this.done) return;
    if (this.resolvers.length > 0) {
      const resolver = this.resolvers.shift()!;
      resolver({ value: message, done: false });
    } else {
      this.queue.push(message);
    }
  }

  end() {
    this.done = true;
    for (const resolver of this.resolvers) {
      resolver({ value: undefined as any, done: true });
    }
    this.resolvers = [];
  }

  [Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    return {
      next: () => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift()!, done: false });
        }
        if (this.done) {
          return Promise.resolve({ value: undefined as any, done: true });
        }
        return new Promise(resolve => {
          this.resolvers.push(resolve);
        });
      }
    };
  }
}

// Builds SDK-compatible user message from string or content array
function buildUserMessage(
  content: string | Array<{ type: string; text?: string; source?: any }>,
  opts?: { parentToolUseId?: string; sessionId?: string },
): SDKUserMessage {
  const messageContent = typeof content === 'string'
    ? [{ type: 'text' as const, text: content }]
    : content;

  return {
    type: 'user',
    session_id: opts?.sessionId || '',
    message: {
      role: 'user',
      content: messageContent as any,
    },
    parent_tool_use_id: opts?.parentToolUseId || null,
  };
}

// --- Tests ---

describe('buildUserMessage', () => {
  test('creates message from string', () => {
    const msg = buildUserMessage('hello world');

    expect(msg.type).toBe('user');
    expect(msg.message.role).toBe('user');
    expect(msg.message.content).toEqual([{ type: 'text', text: 'hello world' }]);
    expect(msg.parent_tool_use_id).toBeNull();
  });

  test('creates message from content array', () => {
    const content = [
      { type: 'text', text: 'describe this image' },
      { type: 'image', source: { type: 'base64', data: 'abc123' } }
    ];
    const msg = buildUserMessage(content);

    expect(msg.type).toBe('user');
    expect(msg.message.content).toEqual(content);
  });

  test('handles empty string', () => {
    const msg = buildUserMessage('');
    expect(msg.message.content).toEqual([{ type: 'text', text: '' }]);
  });

  test('sets parent_tool_use_id when provided', () => {
    const msg = buildUserMessage('JSON', { parentToolUseId: 'toolu_abc123' });
    expect(msg.parent_tool_use_id).toBe('toolu_abc123');
  });

  test('sets session_id when provided', () => {
    const msg = buildUserMessage('hello', { sessionId: 'sess_xyz' });
    expect(msg.session_id).toBe('sess_xyz');
  });

  test('sets both parent_tool_use_id and session_id for AskUserQuestion response', () => {
    const msg = buildUserMessage('YAML', {
      parentToolUseId: 'toolu_ask_001',
      sessionId: 'sess_worker_42',
    });
    expect(msg.parent_tool_use_id).toBe('toolu_ask_001');
    expect(msg.session_id).toBe('sess_worker_42');
    expect(msg.message.content).toEqual([{ type: 'text', text: 'YAML' }]);
  });

  test('defaults to null/empty when opts not provided', () => {
    const msg = buildUserMessage('test');
    expect(msg.parent_tool_use_id).toBeNull();
    expect(msg.session_id).toBe('');
  });
});

describe('MessageStream', () => {
  test('yields messages in order', async () => {
    const stream = new MessageStream();
    const msg1 = buildUserMessage('first');
    const msg2 = buildUserMessage('second');

    stream.enqueue(msg1);
    stream.enqueue(msg2);
    stream.end();

    const results: SDKUserMessage[] = [];
    for await (const msg of stream) {
      results.push(msg);
    }

    expect(results).toHaveLength(2);
    expect((results[0].message.content as any)[0].text).toBe('first');
    expect((results[1].message.content as any)[0].text).toBe('second');
  });

  test('waits for messages when queue is empty', async () => {
    const stream = new MessageStream();
    const msg = buildUserMessage('delayed');

    // Start consuming before messages are added
    const resultPromise = (async () => {
      const results: SDKUserMessage[] = [];
      for await (const m of stream) {
        results.push(m);
      }
      return results;
    })();

    // Add message after a small delay
    await new Promise(r => setTimeout(r, 10));
    stream.enqueue(msg);
    stream.end();

    const results = await resultPromise;
    expect(results).toHaveLength(1);
    expect((results[0].message.content as any)[0].text).toBe('delayed');
  });

  test('ignores messages after end()', () => {
    const stream = new MessageStream();
    const msg1 = buildUserMessage('before');
    const msg2 = buildUserMessage('after');

    stream.enqueue(msg1);
    stream.end();
    stream.enqueue(msg2); // Should be ignored

    // Queue should only have msg1
    expect((stream as any).queue).toHaveLength(1);
  });

  test('resolves waiting consumers on end()', async () => {
    const stream = new MessageStream();

    // Start consuming - will wait for messages
    const resultPromise = (async () => {
      const results: SDKUserMessage[] = [];
      for await (const m of stream) {
        results.push(m);
      }
      return results;
    })();

    // End without adding any messages
    await new Promise(r => setTimeout(r, 10));
    stream.end();

    const results = await resultPromise;
    expect(results).toHaveLength(0);
  });

  test('handles multiple concurrent consumers', async () => {
    const stream = new MessageStream();
    const iterator = stream[Symbol.asyncIterator]();

    // Start two concurrent next() calls
    const promise1 = iterator.next();
    const promise2 = iterator.next();

    // Enqueue two messages
    stream.enqueue(buildUserMessage('one'));
    stream.enqueue(buildUserMessage('two'));
    stream.end();

    const [result1, result2] = await Promise.all([promise1, promise2]);

    expect(result1.done).toBe(false);
    expect(result2.done).toBe(false);
    expect((result1.value.message.content as any)[0].text).toBe('one');
    expect((result2.value.message.content as any)[0].text).toBe('two');
  });
});

// Spec §6 — prompt injection
describe('buildRetryContinuitySection', () => {
  it('returns undefined when context is undefined', () => {
    expect(buildRetryContinuitySection({ context: undefined, defaultBranch: 'dev' })).toBeUndefined();
  });

  it('returns undefined when context has no resumeBranch', () => {
    expect(buildRetryContinuitySection({ context: { baseBranch: 'buildd/abc' }, defaultBranch: 'dev' })).toBeUndefined();
  });

  it('returns undefined when resumeBranch is empty string', () => {
    expect(buildRetryContinuitySection({ context: { resumeBranch: '' }, defaultBranch: 'dev' })).toBeUndefined();
  });

  it('returns a section containing the salvage-vs-restart instruction when resumeBranch is set', () => {
    const section = buildRetryContinuitySection({
      context: { resumeBranch: 'buildd/abc-fix-login' },
      defaultBranch: 'dev',
    });
    expect(section).toBeDefined();
    expect(section).toContain('## Prior Attempt — Assess Before Starting');
    expect(section).toContain('continue/salvage');
    expect(section).toContain('restart');
    expect(section).toContain('buildd/abc-fix-login');
  });

  it('includes git log command referencing resumeBranch', () => {
    const section = buildRetryContinuitySection({
      context: { resumeBranch: 'buildd/abc-fix-login' },
      defaultBranch: 'dev',
    });
    expect(section).toContain('git log --oneline origin/buildd/abc-fix-login..HEAD');
  });

  it('includes git diff command referencing defaultBranch and resumeBranch', () => {
    const section = buildRetryContinuitySection({
      context: { resumeBranch: 'buildd/abc-fix-login' },
      defaultBranch: 'main',
    });
    expect(section).toContain('git diff origin/main...origin/buildd/abc-fix-login');
  });

  it('uses lastCommitSha in the fallback git log command when present', () => {
    const section = buildRetryContinuitySection({
      context: { resumeBranch: 'buildd/abc', lastCommitSha: 'deadbeef' },
      defaultBranch: 'dev',
    });
    expect(section).toContain('deadbeef~1');
  });

  it('falls back to origin/resumeBranch in git log when lastCommitSha is absent', () => {
    const section = buildRetryContinuitySection({
      context: { resumeBranch: 'buildd/abc' },
      defaultBranch: 'dev',
    });
    expect(section).toContain('origin/buildd/abc~1');
  });

  it('includes prior failure summary when failureContext is a structured object', () => {
    const section = buildRetryContinuitySection({
      context: {
        resumeBranch: 'buildd/abc',
        failureContext: { summary: 'TypeScript compilation failed', errorType: 'ci_failure' },
      },
      defaultBranch: 'dev',
    });
    expect(section).toContain('TypeScript compilation failed');
    expect(section).toContain('3. The prior attempt failed with:');
  });

  it('includes prior failure summary when failureContext is a bare string (backward compat)', () => {
    const section = buildRetryContinuitySection({
      context: {
        resumeBranch: 'buildd/abc',
        failureContext: 'Job "test" failed',
      },
      defaultBranch: 'dev',
    });
    expect(section).toContain('Job "test" failed');
  });

  it('omits the failure line when failureContext is absent', () => {
    const section = buildRetryContinuitySection({
      context: { resumeBranch: 'buildd/abc' },
      defaultBranch: 'dev',
    });
    expect(section).not.toContain('The prior attempt failed with:');
    // Step numbering: without failure line, decide step is 3 not 4
    expect(section).toContain('3. Explicitly decide:');
  });

  it('uses step 4 for decision when failureContext is present', () => {
    const section = buildRetryContinuitySection({
      context: { resumeBranch: 'buildd/abc', failureContext: { summary: 'Tests failed' } },
      defaultBranch: 'dev',
    });
    expect(section).toContain('4. Explicitly decide:');
  });
});
