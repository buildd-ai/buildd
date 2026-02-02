/**
 * Unit tests for MessageStream and buildUserMessage helpers
 *
 * These test internal utilities used by WorkerManager for multi-turn
 * conversations with the Claude Agent SDK query() API.
 *
 * Run: bun test __tests__/unit
 */

import { describe, test, expect } from 'bun:test';
import type { SDKUserMessage } from '@anthropic-ai/claude-agent-sdk';

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
function buildUserMessage(content: string | Array<{ type: string; text?: string; source?: any }>): SDKUserMessage {
  const messageContent = typeof content === 'string'
    ? [{ type: 'text' as const, text: content }]
    : content;

  return {
    type: 'user',
    session_id: '',
    message: {
      role: 'user',
      content: messageContent as any,
    },
    parent_tool_use_id: null,
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
