import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import { sendTaskCallback } from './task-callback';

describe('sendTaskCallback', () => {
  let fetchSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    fetchSpy = spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('ok', { status: 200 })
    );
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it('sends POST with correct payload when callback URL exists', async () => {
    const task = {
      id: 'task-123',
      context: {
        callback: {
          url: 'https://example.com/webhook',
          token: 'secret-token',
        },
      },
    };

    await sendTaskCallback(task, {
      status: 'completed',
      summary: 'All done',
      prUrl: 'https://github.com/org/repo/pull/1',
      structuredOutput: { key: 'value' },
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://example.com/webhook');
    expect(options.method).toBe('POST');
    expect(options.headers).toEqual(
      expect.objectContaining({
        'Content-Type': 'application/json',
        Authorization: 'Bearer secret-token',
      })
    );
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      taskId: 'task-123',
      status: 'completed',
      summary: 'All done',
      prUrl: 'https://github.com/org/repo/pull/1',
      structuredOutput: { key: 'value' },
      dashboardUrl: 'https://buildd.dev/app/tasks/task-123',
    });
  });

  it('skips when no callback URL', async () => {
    await sendTaskCallback(
      { id: 'task-1', context: null },
      { status: 'completed' }
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    await sendTaskCallback(
      { id: 'task-2', context: {} },
      { status: 'completed' }
    );
    expect(fetchSpy).not.toHaveBeenCalled();

    await sendTaskCallback(
      { id: 'task-3', context: { callback: {} } },
      { status: 'completed' }
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips for non-HTTPS URLs', async () => {
    await sendTaskCallback(
      {
        id: 'task-4',
        context: { callback: { url: 'http://example.com/webhook' } },
      },
      { status: 'completed' }
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does not include Authorization header when no token', async () => {
    await sendTaskCallback(
      {
        id: 'task-5',
        context: { callback: { url: 'https://example.com/hook' } },
      },
      { status: 'failed', summary: 'Something broke' }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const headers = options.headers as Record<string, string>;
    expect(headers.Authorization).toBeUndefined();
  });

  it('handles fetch timeout/error gracefully', async () => {
    fetchSpy.mockRejectedValue(new Error('timeout'));

    // Should not throw
    await sendTaskCallback(
      {
        id: 'task-6',
        context: { callback: { url: 'https://example.com/hook' } },
      },
      { status: 'completed' }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });
});
