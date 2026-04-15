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

  it('includes worker stats in payload when provided', async () => {
    const task = {
      id: 'task-200',
      context: {
        callback: { url: 'https://example.com/webhook', token: 'tok' },
      },
    };

    await sendTaskCallback(
      task,
      { status: 'completed', summary: 'Done' },
      {
        turns: 42,
        inputTokens: 10000,
        outputTokens: 5000,
        costUsd: '0.1234',
        durationMs: 60000,
        commitCount: 3,
        filesChanged: 5,
        linesAdded: 120,
        linesRemoved: 30,
      }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body).toEqual({
      taskId: 'task-200',
      status: 'completed',
      summary: 'Done',
      dashboardUrl: 'https://buildd.dev/app/tasks/task-200',
      turns: 42,
      inputTokens: 10000,
      outputTokens: 5000,
      costUsd: 0.1234,
      durationMs: 60000,
      commitCount: 3,
      filesChanged: 5,
      linesAdded: 120,
      linesRemoved: 30,
    });
  });

  it('omits null/undefined worker stats fields', async () => {
    const task = {
      id: 'task-201',
      context: {
        callback: { url: 'https://example.com/webhook' },
      },
    };

    await sendTaskCallback(
      task,
      { status: 'completed' },
      {
        turns: 10,
        inputTokens: null,
        outputTokens: undefined as any,
        costUsd: null,
        durationMs: null,
        commitCount: 0,
        filesChanged: null,
        linesAdded: null,
        linesRemoved: null,
      }
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(options.body as string);
    expect(body.turns).toBe(10);
    expect(body.commitCount).toBe(0);
    expect(body).not.toHaveProperty('inputTokens');
    expect(body).not.toHaveProperty('outputTokens');
    expect(body).not.toHaveProperty('costUsd');
    expect(body).not.toHaveProperty('durationMs');
    expect(body).not.toHaveProperty('filesChanged');
    expect(body).not.toHaveProperty('linesAdded');
    expect(body).not.toHaveProperty('linesRemoved');
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
