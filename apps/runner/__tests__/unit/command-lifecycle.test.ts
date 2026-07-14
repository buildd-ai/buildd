/**
 * Unit tests for command_lifecycle frame handling (SDK v0.3.206+).
 *
 * Run: bun test __tests__/unit/command-lifecycle.test.ts
 */

import { describe, test, expect } from 'bun:test';
import {
  applyCommandLifecycle,
  emptyCommandLifecycle,
  type CommandLifecycleTracker,
} from '../../src/command-lifecycle';

describe('applyCommandLifecycle', () => {
  test('counts a queued → started → completed lifecycle', () => {
    const t = emptyCommandLifecycle();
    expect(applyCommandLifecycle(t, { uuid: 'a', state: 'queued' }).changed).toBe(true);
    expect(applyCommandLifecycle(t, { uuid: 'a', state: 'started' }).changed).toBe(true);
    const done = applyCommandLifecycle(t, { uuid: 'a', state: 'completed' });
    expect(done.changed).toBe(true);
    expect(done.state).toBe('completed');
    // Normal lifecycle produces no milestone / currentAction (avoids per-message noise).
    expect(done.milestoneLabel).toBeUndefined();
    expect(done.currentAction).toBeUndefined();
    expect(t.counts).toEqual({ queued: 1, started: 1, completed: 1, cancelled: 0, discarded: 0 });
  });

  test('surfaces a milestone + currentAction for cancelled', () => {
    const t = emptyCommandLifecycle();
    const r = applyCommandLifecycle(t, { uuid: 'x', state: 'cancelled' });
    expect(r.changed).toBe(true);
    expect(r.state).toBe('cancelled');
    expect(r.milestoneLabel).toBe('Request cancelled');
    expect(r.currentAction).toBe('Request cancelled');
    expect(t.counts.cancelled).toBe(1);
  });

  test('surfaces a distinct label for discarded', () => {
    const t = emptyCommandLifecycle();
    const r = applyCommandLifecycle(t, { uuid: 'y', state: 'discarded' });
    expect(r.milestoneLabel).toBe('Queued request discarded');
    expect(r.currentAction).toBe('Queued request discarded');
    expect(t.counts.discarded).toBe(1);
  });

  test('accepts the `status` spelling as an alias for `state`', () => {
    const t = emptyCommandLifecycle();
    const r = applyCommandLifecycle(t, { uuid: 'z', status: 'completed' });
    expect(r.changed).toBe(true);
    expect(r.state).toBe('completed');
    expect(t.counts.completed).toBe(1);
  });

  test('is case-insensitive', () => {
    const t = emptyCommandLifecycle();
    expect(applyCommandLifecycle(t, { uuid: 'c', state: 'CANCELLED' }).state).toBe('cancelled');
    expect(t.counts.cancelled).toBe(1);
  });

  test('ignores unknown / empty states without mutating counts', () => {
    const t = emptyCommandLifecycle();
    expect(applyCommandLifecycle(t, { uuid: 'q', state: 'bogus' }).changed).toBe(false);
    expect(applyCommandLifecycle(t, {}).changed).toBe(false);
    expect(t.counts).toEqual({ queued: 0, started: 0, completed: 0, cancelled: 0, discarded: 0 });
  });

  test('is idempotent for a repeated (uuid, state) frame', () => {
    const t = emptyCommandLifecycle();
    expect(applyCommandLifecycle(t, { uuid: 'a', state: 'completed' }).changed).toBe(true);
    const dup = applyCommandLifecycle(t, { uuid: 'a', state: 'completed' });
    expect(dup.changed).toBe(false);
    expect(dup.state).toBe('completed');
    expect(t.counts.completed).toBe(1);
  });

  test('counts distinct uuids independently', () => {
    const t: CommandLifecycleTracker = emptyCommandLifecycle();
    applyCommandLifecycle(t, { uuid: 'a', state: 'completed' });
    applyCommandLifecycle(t, { uuid: 'b', state: 'completed' });
    expect(t.counts.completed).toBe(2);
  });

  test('still counts frames that omit a uuid (no dedupe key)', () => {
    const t = emptyCommandLifecycle();
    applyCommandLifecycle(t, { state: 'started' });
    applyCommandLifecycle(t, { state: 'started' });
    expect(t.counts.started).toBe(2);
  });
});
