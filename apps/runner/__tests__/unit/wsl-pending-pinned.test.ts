/**
 * Tests for listPendingPinned extended to check hostname and account-name pins.
 *
 * When migrating from Windows runner to WSL runner, we need to identify pending
 * tasks that are pinned to the Windows runner by any of its identities:
 * - headless key (runner:headless://<host>)
 * - bare hostname (runner:<hostname>)
 * - account name (runner:<account-name>)
 */
import { describe, test, expect } from 'bun:test';
import { listPendingPinned } from '../../src/wsl-migrate';

interface MockTask {
  title: string;
  status: string;
  requiredCapabilities?: string[] | null;
}

interface MockResponse {
  tasks?: MockTask[];
  hasMore?: boolean;
  nextCursor?: string | null;
}

describe('listPendingPinned', () => {
  test('identifies tasks pinned by headless key', async () => {
    const mockFetch = async (url: string) => ({
      ok: true,
      json: async (): Promise<MockResponse> => ({
        tasks: [
          {
            title: 'Task A',
            status: 'pending',
            requiredCapabilities: ['runner:headless://DESKTOP-ABC'],
          },
          {
            title: 'Task B',
            status: 'pending',
            requiredCapabilities: ['runner:headless://OTHER-MACHINE'],
          },
        ],
        hasMore: false,
      }),
    });

    const found = await listPendingPinned({
      configFile: '/nonexistent',
      log: () => {},
      fetchFn: mockFetch as any,
      runnerKey: 'headless://DESKTOP-ABC',
      apiKey: 'test-key',
      baseUrl: 'https://buildd.dev',
    });

    expect(found).toEqual([{ title: 'Task A' }]);
  });

  test('identifies tasks pinned by bare hostname', async () => {
    const mockFetch = async (url: string) => ({
      ok: true,
      json: async (): Promise<MockResponse> => ({
        tasks: [
          {
            title: 'Task A',
            status: 'pending',
            requiredCapabilities: ['runner:DESKTOP-ABC'],
          },
          {
            title: 'Task B',
            status: 'pending',
            requiredCapabilities: ['runner:OTHER-MACHINE'],
          },
        ],
        hasMore: false,
      }),
    });

    const found = await listPendingPinned({
      configFile: '/nonexistent',
      log: () => {},
      fetchFn: mockFetch as any,
      runnerKey: 'headless://DESKTOP-ABC',
      apiKey: 'test-key',
      baseUrl: 'https://buildd.dev',
    });

    expect(found).toEqual([{ title: 'Task A' }]);
  });

  test('identifies tasks pinned by account name', async () => {
    const mockFetch = async (url: string) => ({
      ok: true,
      json: async (): Promise<MockResponse> => ({
        tasks: [
          {
            title: 'Task A',
            status: 'pending',
            requiredCapabilities: ['runner:user@contoso'],
          },
          {
            title: 'Task B',
            status: 'pending',
            requiredCapabilities: ['runner:other@contoso'],
          },
        ],
        hasMore: false,
      }),
    });

    const found = await listPendingPinned({
      configFile: '/nonexistent',
      log: () => {},
      fetchFn: mockFetch as any,
      runnerKey: 'headless://DESKTOP-ABC',
      accountName: 'user@contoso',
      apiKey: 'test-key',
      baseUrl: 'https://buildd.dev',
    });

    expect(found).toEqual([{ title: 'Task A' }]);
  });

  test('identifies tasks pinned by any of the three identity types', async () => {
    const mockFetch = async (url: string) => ({
      ok: true,
      json: async (): Promise<MockResponse> => ({
        tasks: [
          {
            title: 'Task by key',
            status: 'pending',
            requiredCapabilities: ['runner:headless://DESKTOP-ABC'],
          },
          {
            title: 'Task by hostname',
            status: 'pending',
            requiredCapabilities: ['runner:DESKTOP-ABC'],
          },
          {
            title: 'Task by account',
            status: 'pending',
            requiredCapabilities: ['runner:user@contoso'],
          },
          {
            title: 'Task for other runner',
            status: 'pending',
            requiredCapabilities: ['runner:OTHER-MACHINE'],
          },
          {
            title: 'Not pending',
            status: 'running',
            requiredCapabilities: ['runner:DESKTOP-ABC'],
          },
        ],
        hasMore: false,
      }),
    });

    const found = await listPendingPinned({
      configFile: '/nonexistent',
      log: () => {},
      fetchFn: mockFetch as any,
      runnerKey: 'headless://DESKTOP-ABC',
      accountName: 'user@contoso',
      apiKey: 'test-key',
      baseUrl: 'https://buildd.dev',
    });

    expect(found).toHaveLength(3);
    expect(found.map(t => t.title)).toContain('Task by key');
    expect(found.map(t => t.title)).toContain('Task by hostname');
    expect(found.map(t => t.title)).toContain('Task by account');
  });

  test('handles pagination correctly', async () => {
    let callCount = 0;
    const mockFetch = async (url: string) => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: true,
          json: async (): Promise<MockResponse> => ({
            tasks: [
              {
                title: 'Task page 1',
                status: 'pending',
                requiredCapabilities: ['runner:DESKTOP-ABC'],
              },
            ],
            hasMore: true,
            nextCursor: 'cursor-2',
          }),
        };
      } else {
        return {
          ok: true,
          json: async (): Promise<MockResponse> => ({
            tasks: [
              {
                title: 'Task page 2',
                status: 'pending',
                requiredCapabilities: ['runner:DESKTOP-ABC'],
              },
            ],
            hasMore: false,
            nextCursor: null,
          }),
        };
      }
    };

    const found = await listPendingPinned({
      configFile: '/nonexistent',
      log: () => {},
      fetchFn: mockFetch as any,
      runnerKey: 'headless://DESKTOP-ABC',
      apiKey: 'test-key',
      baseUrl: 'https://buildd.dev',
    });

    expect(found).toHaveLength(2);
    expect(found.map(t => t.title)).toContain('Task page 1');
    expect(found.map(t => t.title)).toContain('Task page 2');
  });

  test('handles tasks with null requiredCapabilities', async () => {
    const mockFetch = async (url: string) => ({
      ok: true,
      json: async (): Promise<MockResponse> => ({
        tasks: [
          {
            title: 'Task with capabilities',
            status: 'pending',
            requiredCapabilities: ['runner:DESKTOP-ABC'],
          },
          {
            title: 'Task without capabilities',
            status: 'pending',
            requiredCapabilities: null,
          },
        ],
        hasMore: false,
      }),
    });

    const found = await listPendingPinned({
      configFile: '/nonexistent',
      log: () => {},
      fetchFn: mockFetch as any,
      runnerKey: 'headless://DESKTOP-ABC',
      apiKey: 'test-key',
      baseUrl: 'https://buildd.dev',
    });

    expect(found).toEqual([{ title: 'Task with capabilities' }]);
  });

  test('handles API errors gracefully', async () => {
    const mockFetch = async (url: string) => ({
      ok: false,
      status: 401,
    });

    const logs: string[] = [];
    const found = await listPendingPinned({
      configFile: '/nonexistent',
      log: (line) => logs.push(line),
      fetchFn: mockFetch as any,
      runnerKey: 'headless://DESKTOP-ABC',
      apiKey: 'test-key',
      baseUrl: 'https://buildd.dev',
    });

    expect(found).toEqual([]);
    expect(logs.some(l => l.includes('HTTP 401'))).toBe(true);
  });

  test('does not require accountName parameter', async () => {
    const mockFetch = async (url: string) => ({
      ok: true,
      json: async (): Promise<MockResponse> => ({
        tasks: [
          {
            title: 'Task by hostname',
            status: 'pending',
            requiredCapabilities: ['runner:DESKTOP-ABC'],
          },
        ],
        hasMore: false,
      }),
    });

    const found = await listPendingPinned({
      configFile: '/nonexistent',
      log: () => {},
      fetchFn: mockFetch as any,
      runnerKey: 'headless://DESKTOP-ABC',
      apiKey: 'test-key',
      baseUrl: 'https://buildd.dev',
      // accountName is optional
    });

    expect(found).toEqual([{ title: 'Task by hostname' }]);
  });
});
