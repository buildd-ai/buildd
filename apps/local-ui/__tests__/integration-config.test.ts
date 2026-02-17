/**
 * Config & Connectivity Integration Tests
 *
 * Verifies server URL changes, reconnection, and error handling
 * without needing Claude credentials or real task execution.
 *
 * Requires: local-ui running on port 8766
 *
 * Run: bun test:integration-config
 */

import { describe, test, expect, beforeAll, afterAll } from 'bun:test';

const BASE_URL = process.env.LOCAL_UI_URL || 'http://localhost:8766';

// --- Helpers ---

let viewerToken: string | null = null;

async function api(path: string, method = 'GET', body?: any): Promise<Response> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  // Pass viewer token for protected endpoints when available
  if (viewerToken) {
    headers['Authorization'] = `Bearer ${viewerToken}`;
  }
  return fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
}

async function apiJson<T = any>(path: string, method = 'GET', body?: any): Promise<T> {
  const res = await api(path, method, body);
  return res.json();
}

async function restoreServer(url: string) {
  await api('/api/config/server', 'POST', { server: url });
}

// --- Setup & Teardown ---

// Use BUILDD_TEST_SERVER as the known-good server, not whatever config currently has
// (a previous crashed run may have left it pointing at localhost:1)
const KNOWN_GOOD_SERVER = process.env.BUILDD_TEST_SERVER || 'https://buildd.dev';
let originalServer: string;

beforeAll(async () => {
  // Verify local-ui is running
  try {
    const config = await apiJson<{ builddServer: string; viewerToken?: string }>('/api/config');
    originalServer = config.builddServer;
    viewerToken = config.viewerToken || null;
    console.log(`Original server URL: ${originalServer}`);
    if (viewerToken) console.log(`Viewer token acquired`);

    // Ensure we start with a valid server URL (previous run may have left bogus URL)
    if (originalServer !== KNOWN_GOOD_SERVER) {
      console.log(`Restoring to known-good server: ${KNOWN_GOOD_SERVER}`);
      await api('/api/config/server', 'POST', { server: KNOWN_GOOD_SERVER });
      originalServer = KNOWN_GOOD_SERVER;
    }
  } catch (err: any) {
    if (err.message?.includes('fetch failed')) {
      throw new Error(`Local-UI not running at ${BASE_URL}. Start with: bun run dev`);
    }
    throw err;
  }
});

afterAll(async () => {
  // Always restore to the known-good server
  try {
    const res = await api('/api/config/server', 'POST', { server: KNOWN_GOOD_SERVER });
    const data = await res.json();
    console.log(`Restored server URL to: ${data.builddServer}`);
  } catch {
    console.log(`Warning: could not restore server URL`);
  }
});

// --- Tests ---
// Non-destructive tests run first, destructive URL-change tests run last.

describe('Config & Connectivity', () => {
  describe('Server URL Validation', () => {
    test('rejects missing server URL', async () => {
      const res = await api('/api/config/server', 'POST', {});
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain('server URL required');
    });

    test('rejects invalid protocol', async () => {
      const res = await api('/api/config/server', 'POST', { server: 'ftp://example.com' });
      expect(res.status).toBe(400);

      const data = await res.json();
      expect(data.error).toContain('http');
    });
  });

  describe('SSE with valid server', () => {
    test('GET /api/events returns event-stream content type', async () => {
      const res = await api('/api/events');
      const contentType = res.headers.get('content-type') || '';

      expect(contentType).toContain('text/event-stream');

      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);

      expect(text).toContain('"type":"init"');
      reader.cancel();
    });

    test('SSE init includes all config fields', async () => {
      const res = await api('/api/events');
      const reader = res.body!.getReader();

      // Accumulate chunks until we have a complete SSE event (ends with \n\n)
      let text = '';
      for (let i = 0; i < 5; i++) {
        const { value, done } = await reader.read();
        if (done) break;
        text += new TextDecoder().decode(value);
        if (text.includes('\n\n')) break;
      }
      reader.cancel();

      const match = text.match(/data: (.+)\n/);
      expect(match).toBeTruthy();
      const initData = JSON.parse(match![1]);

      // These fields must all be present so the frontend doesn't lose settings on SSE reconnect
      expect(initData.config).toBeDefined();
      expect(initData.config.builddServer).toBeTruthy();
      expect(initData.config.maxConcurrent).toBeGreaterThan(0);
      expect(typeof initData.config.model).toBe('string');
      expect(typeof initData.config.bypassPermissions).toBe('boolean');
      expect(typeof initData.config.acceptRemoteTasks).toBe('boolean');
      expect(typeof initData.config.openBrowser).toBe('boolean');
    });

    test('multiple SSE connections can be opened and closed without error', async () => {
      const connections: ReadableStreamDefaultReader[] = [];

      // Open 3 SSE connections
      for (let i = 0; i < 3; i++) {
        const res = await api('/api/events');
        const reader = res.body!.getReader();
        const { value } = await reader.read();
        const text = new TextDecoder().decode(value);
        expect(text).toContain('"type":"init"');
        connections.push(reader);
      }

      // Close all connections
      for (const reader of connections) {
        await reader.cancel();
      }

      // Verify SSE still works after closing all connections
      const res = await api('/api/events');
      const reader = res.body!.getReader();
      const { value } = await reader.read();
      const text = new TextDecoder().decode(value);
      expect(text).toContain('"type":"init"');
      await reader.cancel();
    });
  });

  describe('API Error Responses', () => {
    test('abort with invalid worker returns error JSON', async () => {
      const res = await api('/api/abort', 'POST', { workerId: 'nonexistent-worker-id' });
      const contentType = res.headers.get('content-type') || '';

      expect(contentType).toContain('application/json');
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('send message to invalid worker returns 404', async () => {
      const res = await api('/api/workers/nonexistent-worker-id/send', 'POST', { message: 'hello' });
      const contentType = res.headers.get('content-type') || '';

      expect(contentType).toContain('application/json');
      expect(res.status).toBe(404);

      const data = await res.json();
      expect(data.error).toBeTruthy();
    });

    test('retry with invalid worker returns error JSON', async () => {
      const res = await api('/api/retry', 'POST', { workerId: 'nonexistent-worker-id' });
      const contentType = res.headers.get('content-type') || '';

      expect(contentType).toContain('application/json');
      const data = await res.json();
      expect(data).toBeDefined();
    });

    test('mark done with invalid worker returns error JSON', async () => {
      const res = await api('/api/done', 'POST', { workerId: 'nonexistent-worker-id' });
      const contentType = res.headers.get('content-type') || '';

      expect(contentType).toContain('application/json');
      const data = await res.json();
      expect(data).toBeDefined();
    });
  });

  describe('Config Endpoint Completeness', () => {
    test('GET /api/config includes accountId', async () => {
      const config = await apiJson('/api/config');

      // accountId is critical for the "Assigned Elsewhere" filter
      // When null, all assigned tasks show as "elsewhere"
      expect('accountId' in config).toBe(true);
    });
  });

  // --- Destructive tests last (these change the server URL and can crash local-ui) ---

  describe('Server URL Change', () => {
    test('POST /api/config/server updates the server URL', async () => {
      const newUrl = 'http://localhost:1';
      const res = await api('/api/config/server', 'POST', { server: newUrl });
      const data = await res.json();

      expect(res.status).toBe(200);
      expect(data.ok).toBe(true);
      expect(data.builddServer).toBe(newUrl);
    });

    test('GET /api/config reflects the new server URL', async () => {
      const config = await apiJson<{ builddServer: string }>('/api/config');
      expect(config.builddServer).toBe('http://localhost:1');
    });

    test('GET /api/tasks returns JSON (not HTML) when server is unreachable', async () => {
      const res = await api('/api/tasks');
      const contentType = res.headers.get('content-type') || '';

      expect(contentType).toContain('application/json');

      const data = await res.json();
      expect(Array.isArray(data.tasks)).toBe(true);
    });
  });

  describe('Error Handling Returns JSON', () => {
    test('GET /api/tasks returns 502 with empty tasks when server is unreachable', async () => {
      // Ensure we're pointed at an unreachable server
      await api('/api/config/server', 'POST', { server: 'http://localhost:1' });

      const res = await api('/api/tasks');
      const data = await res.json();

      expect(res.status).toBe(502);
      expect(data.error).toBeTruthy();
      expect(data.tasks).toEqual([]);
    });

    test('POST /api/tasks returns JSON error when server is unreachable', async () => {
      const res = await api('/api/tasks', 'POST', {
        title: 'Test Task',
        description: 'Should fail gracefully',
        workspaceId: 'fake-workspace',
      });
      const contentType = res.headers.get('content-type') || '';

      expect(contentType).toContain('application/json');
      expect(res.status).toBe(502);

      const data = await res.json();
      expect(data.error).toBeTruthy();
    });
  });

  describe('Restore & Round-trip', () => {
    test('restoring original URL works', async () => {
      const res = await api('/api/config/server', 'POST', { server: originalServer });
      const data = await res.json();

      expect(data.ok).toBe(true);
      expect(data.builddServer).toBe(originalServer);

      // Verify config reflects restoration
      const config = await apiJson<{ builddServer: string }>('/api/config');
      expect(config.builddServer).toBe(originalServer);
    });
  });
});
