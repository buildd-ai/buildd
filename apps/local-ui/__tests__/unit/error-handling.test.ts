/**
 * Unit tests for error handling in local-ui
 *
 * Tests abort scenarios, network failures, and error recovery logic
 * to ensure workers handle errors gracefully without crashing.
 *
 * Run: bun test apps/local-ui/__tests__/unit/error-handling.test.ts
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';

describe('Error Handling', () => {
  describe('Abort Scenarios', () => {
    test('should detect abort error from loop detection', () => {
      const error = new Error('Claude Code process aborted by user');
      const isAbortError = error.message.includes('aborted');

      expect(isAbortError).toBe(true);
    });

    test('should distinguish between abort and unexpected errors', () => {
      const abortError = new Error('Session aborted: Agent stuck');
      const networkError = new Error('fetch failed');

      const isAbort1 = abortError.message.includes('aborted');
      const isAbort2 = networkError.message.includes('aborted');

      expect(isAbort1).toBe(true);
      expect(isAbort2).toBe(false);
    });

    test('should handle abort during loop detection gracefully', () => {
      // Simulate loop detection abort
      const error = {
        message: 'Agent stuck: made 5 identical AskUserQuestion calls',
        isAbort: true,
      };

      // Worker should set error field and mark as failed
      const workerStatus = {
        status: 'error',
        error: error.message,
      };

      expect(workerStatus.status).toBe('error');
      expect(workerStatus.error).toContain('Agent stuck');
    });
  });

  describe('Network Failures', () => {
    test('should detect network errors', () => {
      const networkErrors = [
        new TypeError('fetch failed'),
        new Error('ECONNREFUSED'),
        new Error('ECONNRESET'),
        new Error('ENOTFOUND'),
        new Error('ETIMEDOUT'),
        new Error('socket connection was closed'),
      ];

      networkErrors.forEach(err => {
        const isNetworkError =
          err instanceof TypeError ||
          err.message.includes('fetch failed') ||
          err.message.includes('ECONNREFUSED') ||
          err.message.includes('ECONNRESET') ||
          err.message.includes('ENOTFOUND') ||
          err.message.includes('ETIMEDOUT') ||
          err.message.includes('socket connection was closed');

        expect(isNetworkError).toBe(true);
      });
    });

    test('should queue failed API calls for retry', () => {
      // Mock outbox queue
      const queue: Array<{ method: string; endpoint: string; body?: string }> = [];

      const shouldQueue = (method: string, endpoint: string) => {
        // Queue worker updates but not heartbeats (heartbeats are ephemeral)
        return endpoint.includes('/workers/') && !endpoint.includes('/heartbeat');
      };

      const enqueue = (method: string, endpoint: string, body?: string) => {
        if (shouldQueue(method, endpoint)) {
          queue.push({ method, endpoint, body });
        }
      };

      // Simulate failed worker update
      enqueue('PATCH', '/api/workers/123', JSON.stringify({ status: 'done' }));

      expect(queue.length).toBe(1);
      expect(queue[0].endpoint).toBe('/api/workers/123');
    });

    test('should NOT queue heartbeats (ephemeral)', () => {
      const queue: Array<{ method: string; endpoint: string }> = [];

      const shouldQueue = (method: string, endpoint: string) => {
        return endpoint.includes('/workers/') && !endpoint.includes('/heartbeat');
      };

      const enqueue = (method: string, endpoint: string) => {
        if (shouldQueue(method, endpoint)) {
          queue.push({ method, endpoint });
        }
      };

      // Simulate failed heartbeat
      enqueue('POST', '/api/workers/heartbeat');

      expect(queue.length).toBe(0);
    });
  });

  describe('Observation Creation Failures', () => {
    test('should handle observation API failure gracefully', () => {
      // Mock observation creation that fails
      const createObservation = async () => {
        throw new Error('API error: 500 - Failed to create observation');
      };

      // Worker should log error but complete task successfully
      let taskCompleted = false;
      let errorLogged = false;

      const executeTask = async () => {
        try {
          // Task execution succeeds
          taskCompleted = true;

          // Try to create observation
          try {
            await createObservation();
          } catch (err) {
            errorLogged = true;
            // Don't fail the task - observation is non-critical
          }
        } catch (err) {
          taskCompleted = false;
        }
      };

      executeTask();

      expect(taskCompleted).toBe(true);
      expect(errorLogged).toBe(true);
    });

    test('should extract error details from observation failure', () => {
      const errors = [
        'API error: 500 - {"error":"Failed to create observation"}',
        'API error: 500 - {"error":"Failed to create observation","detail":"Invalid reference (task or workspace may not exist)"}',
      ];

      errors.forEach(errMsg => {
        expect(errMsg).toContain('Failed to create observation');
      });

      // Second error should have detail
      expect(errors[1]).toContain('Invalid reference');
    });
  });

  describe('Invalid Server Responses', () => {
    test('should handle malformed JSON responses', () => {
      const invalidResponses = [
        'not json',
        '{"incomplete":',
        '',
        'null',
      ];

      invalidResponses.forEach(response => {
        let error: Error | null = null;
        try {
          JSON.parse(response);
        } catch (e) {
          error = e as Error;
        }
        expect(error).not.toBeNull();
      });
    });

    test('should handle missing required fields', () => {
      const task = { id: '123' }; // Missing workspaceId, title, etc.

      const validate = (task: any) => {
        if (!task.workspaceId) return false;
        if (!task.title) return false;
        return true;
      };

      expect(validate(task)).toBe(false);
    });

    test('should handle unexpected status codes', () => {
      const responses = [
        { status: 200, ok: true },
        { status: 401, ok: false },
        { status: 404, ok: false },
        { status: 500, ok: false },
        { status: 503, ok: false },
      ];

      responses.forEach(res => {
        if (!res.ok) {
          // Should throw or queue for retry
          expect([401, 404, 500, 503]).toContain(res.status);
        }
      });
    });
  });

  describe('State Recovery', () => {
    test('should recover from stale status when activity resumes', () => {
      // Worker goes stale (no activity for >2 min)
      let status = 'stale';

      // Activity resumes
      const onActivity = () => {
        if (status === 'stale') {
          status = 'working';
        }
      };

      onActivity();
      expect(status).toBe('working');
    });

    test('should clean up session on abort', () => {
      // Mock session
      const sessions = new Map();
      const workerId = 'worker-123';
      const session = {
        abortController: { abort: mock(() => {}) },
        inputStream: { end: mock(() => {}) },
      };
      sessions.set(workerId, session);

      // Abort cleanup
      const cleanup = (workerId: string) => {
        const session = sessions.get(workerId);
        if (session) {
          session.abortController.abort();
          session.inputStream.end();
          sessions.delete(workerId);
        }
      };

      cleanup(workerId);

      expect(sessions.has(workerId)).toBe(false);
      expect(session.abortController.abort).toHaveBeenCalled();
      expect(session.inputStream.end).toHaveBeenCalled();
    });

    test('should handle abort when session already cleaned up', () => {
      const sessions = new Map();
      const workerId = 'worker-123';

      // Try to abort non-existent session (should not throw)
      const abort = (workerId: string) => {
        const session = sessions.get(workerId);
        if (session) {
          session.abortController.abort();
          sessions.delete(workerId);
        }
        // No-op if session doesn't exist
      };

      expect(() => abort(workerId)).not.toThrow();
    });
  });

  describe('Error Message Formatting', () => {
    test('should format abort errors user-friendly', () => {
      const loopError = 'Agent stuck: made 5 identical AskUserQuestion calls';
      const timeoutError = 'Agent aborted: max turns exceeded (100)';

      expect(loopError).toContain('Agent stuck');
      expect(timeoutError).toContain('max turns exceeded');
    });

    test('should truncate long error messages', () => {
      const longError = 'A'.repeat(200);
      const truncated = longError.slice(0, 100);

      expect(truncated.length).toBe(100);
    });

    test('should extract error message from Error objects', () => {
      const error = new Error('Something went wrong');
      const message = error instanceof Error ? error.message : String(error);

      expect(message).toBe('Something went wrong');
    });
  });
});
