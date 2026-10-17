/**
 * The claim storm (task 9e12f377 part 4): a broadcast assignment the server
 * keeps refusing for the same reason is not re-claimed on every event.
 */
import { describe, expect, test } from 'bun:test';
import { ClaimRefusalBackoff } from '../../src/claim-refusal-backoff';

const T0 = 1_000_000;

describe('ClaimRefusalBackoff', () => {
  test('a refused task is skipped until the backoff runs out, then tried once more', () => {
    const b = new ClaimRefusalBackoff();
    b.refused('task-a', 'soft_overlap', 'task-h', T0);
    expect(b.skip('task-a', T0 + 1_000)).not.toBeNull();
    expect(b.skip('task-a', T0 + 29_999)).not.toBeNull();
    expect(b.skip('task-a', T0 + 30_000)).toBeNull();
    expect(b.skip('task-b', T0)).toBeNull();
  });

  test('the same reason again doubles the wait, up to 15 minutes; a new reason starts over', () => {
    const b = new ClaimRefusalBackoff();
    let t = T0;
    const waits: number[] = [];
    for (let i = 0; i < 8; i++) {
      const e = b.refused('task-a', 'soft_overlap', 'task-h', t);
      waits.push(e.until - t);
      t = e.until;
    }
    expect(waits).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 900_000, 900_000, 900_000]);
    expect(b.refused('task-a', 'soft_overlap', 'task-other', t).until - t).toBe(30_000);
    expect(b.refused('task-a', 'mission_concurrent', null, t).until - t).toBe(30_000);
  });

  test('the task it waits for ending here lifts it at once; another task ending does not', () => {
    const b = new ClaimRefusalBackoff();
    b.refused('task-a', 'soft_overlap', 'task-h', T0);
    b.agentEnded('task-x');
    expect(b.skip('task-a', T0 + 1)).not.toBeNull();
    b.agentEnded('task-h');
    expect(b.skip('task-a', T0 + 2)).toBeNull();
  });

  test('a refusal with no holder (a cap, a slot) lifts when any agent here ends', () => {
    const b = new ClaimRefusalBackoff();
    b.refused('task-a', 'workspace_cap', null, T0);
    b.agentEnded('task-x');
    expect(b.skip('task-a', T0 + 1)).toBeNull();
  });

  test('raised slots or a lifted hold reset everything; a claim clears its task', () => {
    const b = new ClaimRefusalBackoff();
    b.refused('task-a', 'soft_overlap', 'task-h', T0);
    b.refused('task-b', 'path_overlap', 'task-h', T0);
    b.clear('task-a');
    expect(b.skip('task-a', T0 + 1)).toBeNull();
    expect(b.size).toBe(1);
    b.reset();
    expect(b.size).toBe(0);
  });

  test('a storm of assignments over ten minutes makes a handful of claims, not thousands', () => {
    const b = new ClaimRefusalBackoff();
    let claims = 0;
    // An assignment every 200ms (the rate the owner's log showed), each refused the same way.
    for (let t = T0; t < T0 + 10 * 60_000; t += 200) {
      if (b.skip('task-a', t)) continue;
      claims++;
      b.refused('task-a', 'soft_overlap', 'task-h', t);
    }
    expect(claims).toBeLessThanOrEqual(6);
    expect(b.takeSkipped()).toBeGreaterThan(2_900);
  });
});
