import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import { MemoryClient } from './memory-client';

// ── Mock global fetch ──────────────────────────────────────────────────────

const originalFetch = globalThis.fetch;
const mockFetch = mock(() => Promise.resolve(new Response('{}', { status: 200 })));

describe('MemoryClient', () => {
  let client: MemoryClient;

  beforeEach(() => {
    globalThis.fetch = mockFetch as any;
    mockFetch.mockReset();
    client = new MemoryClient('http://memory.test', 'test-api-key');
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('sends x-api-key header on every request', async () => {
    mockFetch.mockResolvedValue(new Response(JSON.stringify({ markdown: '', count: 0 }), { status: 200 }));

    await client.getContext();

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0] as any;
    expect(opts.headers['x-api-key']).toBe('test-api-key');
    expect(opts.headers['Content-Type']).toBe('application/json');
  });

  describe('getContext', () => {
    it('fetches context without project filter', async () => {
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify({ markdown: '## Memories\n- Pattern: artifacts dismissed', count: 3 }),
        { status: 200 },
      ));

      const result = await client.getContext();

      expect(result.markdown).toContain('artifacts dismissed');
      expect(result.count).toBe(3);
      const [url] = mockFetch.mock.calls[0] as any;
      expect(url).toBe('http://memory.test/api/memories/context');
    });

    it('fetches context with project filter', async () => {
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify({ markdown: 'project memories', count: 1 }),
        { status: 200 },
      ));

      await client.getContext('my-project');

      const [url] = mockFetch.mock.calls[0] as any;
      expect(url).toBe('http://memory.test/api/memories/context?project=my-project');
    });
  });

  describe('save', () => {
    it('creates a new memory via POST', async () => {
      const saved = {
        memory: {
          id: 'mem-1',
          teamId: 'team-1',
          type: 'pattern',
          title: 'User feedback: artifact content frequently dismissed',
          content: 'Users dismissed 5 artifact item(s)',
          project: null,
          tags: ['feedback-digest', 'user-preference', 'artifact', 'dismiss'],
          files: [],
          source: 'feedback-digest-cron',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      };
      mockFetch.mockResolvedValue(new Response(JSON.stringify(saved), { status: 200 }));

      const result = await client.save({
        type: 'pattern',
        title: 'User feedback: artifact content frequently dismissed',
        content: 'Users dismissed 5 artifact item(s)',
        tags: ['feedback-digest', 'user-preference', 'artifact', 'dismiss'],
        source: 'feedback-digest-cron',
      });

      expect(result.memory.id).toBe('mem-1');
      expect(result.memory.tags).toContain('feedback-digest');

      const [url, opts] = mockFetch.mock.calls[0] as any;
      expect(url).toBe('http://memory.test/api/memories');
      expect(opts.method).toBe('POST');
    });
  });

  describe('search', () => {
    it('searches with query and type params', async () => {
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify({
          results: [{ id: 'mem-1', title: 'feedback pattern', type: 'pattern', createdAt: '2025-01-01' }],
          total: 1,
          limit: 10,
          offset: 0,
        }),
        { status: 200 },
      ));

      const result = await client.search({ query: 'feedback artifact', type: 'pattern' });

      expect(result.results.length).toBe(1);
      const [url] = mockFetch.mock.calls[0] as any;
      expect(url).toContain('query=feedback+artifact');
      expect(url).toContain('type=pattern');
    });
  });

  describe('update', () => {
    it('updates memory via PATCH', async () => {
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify({ memory: { id: 'mem-1', content: 'updated content' } }),
        { status: 200 },
      ));

      await client.update('mem-1', { content: 'updated content' });

      const [url, opts] = mockFetch.mock.calls[0] as any;
      expect(url).toBe('http://memory.test/api/memories/mem-1');
      expect(opts.method).toBe('PATCH');
    });
  });

  describe('batch', () => {
    it('fetches multiple memories by IDs', async () => {
      mockFetch.mockResolvedValue(new Response(
        JSON.stringify({
          memories: [
            { id: 'mem-1', title: 'Pattern 1' },
            { id: 'mem-2', title: 'Pattern 2' },
          ],
        }),
        { status: 200 },
      ));

      const result = await client.batch(['mem-1', 'mem-2']);

      expect(result.memories.length).toBe(2);
      const [url] = mockFetch.mock.calls[0] as any;
      expect(url).toContain('ids=mem-1,mem-2');
    });

    it('returns empty array for empty IDs', async () => {
      const result = await client.batch([]);
      expect(result.memories).toEqual([]);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('error handling', () => {
    it('throws on non-OK responses', async () => {
      mockFetch.mockResolvedValue(new Response('Not found', { status: 404 }));

      await expect(client.getContext()).rejects.toThrow('Memory API 404');
    });
  });
});
