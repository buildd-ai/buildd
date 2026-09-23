/**
 * teardownSession — the one abort+end+delete sequence every SDK session
 * termination path needs, so a session never keeps running as an untracked
 * `claude` CLI subprocess after its worker record leaves the sessions map.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/session-teardown.test.ts
 */

import { describe, test, expect, mock } from 'bun:test';

mock.module('../../src/session-logger', () => ({
  sessionLog: mock(() => {}),
}));

import { reapSession, teardownSession } from '../../src/session-teardown';

function makeSession(overrides: Partial<{ abort: () => void; end: () => void }> = {}) {
  const abortController = { abort: mock(overrides.abort ?? (() => {})) } as unknown as AbortController;
  const inputStream = { end: mock(overrides.end ?? (() => {})) };
  return { abortController, inputStream };
}

describe('teardownSession', () => {
  test('aborts the controller, ends the stream, and deletes the map entry', () => {
    const sessions = new Map<string, any>();
    const session = makeSession();
    sessions.set('w-1', session);

    teardownSession(sessions, 'w-1');

    expect(session.abortController.abort).toHaveBeenCalledTimes(1);
    expect(session.inputStream.end).toHaveBeenCalledTimes(1);
    expect(sessions.has('w-1')).toBe(false);
  });

  test('is a no-op when there is no session for the id', () => {
    const sessions = new Map<string, any>();

    expect(() => teardownSession(sessions, 'missing')).not.toThrow();
    expect(sessions.has('missing')).toBe(false);
  });

  test('still ends the stream and deletes when abort() throws', () => {
    const sessions = new Map<string, any>();
    const session = makeSession({
      abort: () => { throw new Error('already aborted'); },
    });
    sessions.set('w-1', session);

    expect(() => teardownSession(sessions, 'w-1')).not.toThrow();
    expect(session.inputStream.end).toHaveBeenCalledTimes(1);
    expect(sessions.has('w-1')).toBe(false);
  });

  test('still deletes when inputStream.end() throws', () => {
    const sessions = new Map<string, any>();
    const session = makeSession({
      end: () => { throw new Error('stream already closed'); },
    });
    sessions.set('w-1', session);

    expect(() => teardownSession(sessions, 'w-1')).not.toThrow();
    expect(session.abortController.abort).toHaveBeenCalledTimes(1);
    expect(sessions.has('w-1')).toBe(false);
  });

  test('still deletes when both abort() and end() throw', () => {
    const sessions = new Map<string, any>();
    const session = makeSession({
      abort: () => { throw new Error('boom'); },
      end: () => { throw new Error('boom'); },
    });
    sessions.set('w-1', session);

    expect(() => teardownSession(sessions, 'w-1')).not.toThrow();
    expect(sessions.has('w-1')).toBe(false);
  });
});

describe('reapSession', () => {
  test('marks reapedAt, aborts and ends the stream, but keeps the map entry', () => {
    const sessions = new Map<string, any>();
    const session = makeSession();
    sessions.set('w-1', session);

    reapSession(session as any, 1234, 'w-1');

    expect((session as any).reapedAt).toBe(1234);
    expect(session.abortController.abort).toHaveBeenCalledTimes(1);
    expect(session.inputStream.end).toHaveBeenCalledTimes(1);
    // The session's own finally block needs the entry to run its cleanup.
    expect(sessions.has('w-1')).toBe(true);
  });

  test('sets reapedAt before abort fires, so the abort handler can see it', () => {
    let seen: number | undefined;
    const session: any = makeSession({ abort: () => { seen = session.reapedAt; } });

    reapSession(session, 99, 'w-1');

    expect(seen).toBe(99);
  });

  test('still ends the stream when abort() throws', () => {
    const session = makeSession({ abort: () => { throw new Error('boom'); } });

    expect(() => reapSession(session as any, 1, 'w-1')).not.toThrow();
    expect(session.inputStream.end).toHaveBeenCalledTimes(1);
  });
});
