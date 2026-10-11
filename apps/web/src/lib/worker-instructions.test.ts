import { describe, expect, it } from 'bun:test';
import {
  appendInstructionHistory,
  messageDeliveryStatus,
  isUnreachableWorkerStatus,
  markInstructionsDelivered,
  markInstructionsAcknowledged,
  pendingInstructionIds,
  queueInstruction,
} from './worker-instructions';
import { TERMINAL_WORKER_STATUSES } from '@buildd/shared';

describe('isUnreachableWorkerStatus', () => {
  // The check-in route 409s every terminal status, superseded included, so an
  // instruction queued for one can never be collected.
  it('matches the check-in route terminal set, superseded included', () => {
    for (const s of TERMINAL_WORKER_STATUSES) expect(isUnreachableWorkerStatus(s)).toBe(true);
    expect(isUnreachableWorkerStatus('superseded')).toBe(true);
    expect(isUnreachableWorkerStatus('running')).toBe(false);
    expect(isUnreachableWorkerStatus('paused')).toBe(false);
  });
});

describe('appendInstructionHistory — turnAtSend', () => {
  it('records the worker\'s turn count at send time', () => {
    const history = appendInstructionHistory(null, { message: 'stop', isSensitive: false, deliveryState: 'pending', turnAtSend: 4 });
    expect(history[0]).toMatchObject({ message: 'stop', turnAtSend: 4 });
  });

  it('a sensitive workspace still carries turnAtSend without the message text', () => {
    const history = appendInstructionHistory(null, { message: 'secret', isSensitive: true, deliveryState: 'pending', turnAtSend: 2 });
    expect(history[0]).toMatchObject({ turnAtSend: 2 });
    expect(history[0].message).toBeUndefined();
  });

  it('omits turnAtSend when the caller has no turn count to give', () => {
    const history = appendInstructionHistory(null, { message: 'x', isSensitive: false, deliveryState: 'pending' });
    expect(history[0].turnAtSend).toBeUndefined();
  });
});

describe('messageDeliveryStatus — B-1 matrix', () => {
  const at = { timestamp: 100, deliveredAt: 200, acknowledgedAt: 300 };
  // An entry delivered by id is one whose consumer will acknowledge it.
  const byId = { awaitsAck: true as const };

  it('{pending, delivered, acknowledged} × {live, terminal}', () => {
    expect(messageDeliveryStatus({ deliveryState: 'pending', ...at }, 'running')).toEqual({ state: 'queued', at: 100 });
    expect(messageDeliveryStatus({ deliveryState: 'delivered', ...byId, ...at }, 'running')).toEqual({ state: 'delivered', at: 200 });
    expect(messageDeliveryStatus({ deliveryState: 'acknowledged', ...at }, 'running')).toEqual({ state: 'acknowledged', at: 300 });

    expect(messageDeliveryStatus({ deliveryState: 'pending', ...at }, 'completed')).toEqual({ state: 'undelivered', at: null });
    expect(messageDeliveryStatus({ deliveryState: 'delivered', ...byId, ...at }, 'failed')).toEqual({ state: 'undelivered', at: null });
    // Read is read, whatever happened to the run afterwards.
    expect(messageDeliveryStatus({ deliveryState: 'acknowledged', ...at }, 'completed')).toEqual({ state: 'acknowledged', at: 300 });
  });

  it('every terminal status (superseded included) makes a queued message undelivered', () => {
    for (const s of TERMINAL_WORKER_STATUSES) {
      expect(messageDeliveryStatus({ deliveryState: 'pending', timestamp: 1 }, s).state).toBe('undelivered');
    }
  });

  it('no worker status given: treated as live', () => {
    expect(messageDeliveryStatus({ deliveryState: 'pending', timestamp: 1 }).state).toBe('queued');
    expect(messageDeliveryStatus({ deliveryState: undefined, timestamp: 1 }).state).toBe('queued');
  });

  it('a delivery no consumer will ever acknowledge stays delivered after the run ends', () => {
    // Old runners settle by text and never acknowledge; legacy Pusher-only sends
    // are recorded delivered at send time. Neither may turn into "not delivered".
    expect(messageDeliveryStatus({ deliveryState: 'delivered', timestamp: 1 }, 'completed')).toEqual({ state: 'delivered', at: 1 });
  });

  it('workers.turns plays no part — there is no "read at turn N"', () => {
    expect(messageDeliveryStatus({ deliveryState: 'delivered', ...byId, turnAtSend: 1, timestamp: 5, deliveredAt: 6 }, 'running').state).toBe('delivered');
  });
});

describe('appendInstructionHistory — ids', () => {
  it('stamps every new entry with a server-generated id', () => {
    const h = appendInstructionHistory(null, { message: 'a', isSensitive: false, deliveryState: 'pending' });
    const h2 = appendInstructionHistory(h, { message: 'b', isSensitive: true, deliveryState: 'pending' });
    expect(typeof h2[0].id).toBe('string');
    expect(typeof h2[1].id).toBe('string');
    expect(h2[0].id).not.toBe(h2[1].id);
  });
});

describe('markInstructionsDelivered', () => {
  const history = () => [
    { id: 'i1', type: 'instruction' as const, message: 'first', timestamp: 1, deliveryState: 'pending' as const },
    { id: 'i2', type: 'instruction' as const, message: 'second', timestamp: 2, deliveryState: 'pending' as const },
  ];

  it('settles by id when ids are given, and only those', () => {
    const out = markInstructionsDelivered(history(), 'first\n\nsecond', ['i1'], 500);
    expect(out[0]).toMatchObject({ deliveryState: 'delivered', deliveredAt: 500, awaitsAck: true });
    expect(out[1].deliveryState).toBe('pending');
  });

  it('falls back to text match for consumers that send no ids', () => {
    const out = markInstructionsDelivered(history(), 'second', undefined, 500);
    expect(out[0].deliveryState).toBe('pending');
    expect(out[1]).toMatchObject({ deliveryState: 'delivered', deliveredAt: 500 });
    expect(out[1].awaitsAck).toBeUndefined();
  });

  it('never moves an acknowledged entry backwards', () => {
    const h = [{ id: 'i1', type: 'instruction' as const, message: 'x', timestamp: 1, deliveryState: 'acknowledged' as const, acknowledgedAt: 9 }];
    expect(markInstructionsDelivered(h, 'x', ['i1'], 10)[0].deliveryState).toBe('acknowledged');
  });
});

describe('markInstructionsAcknowledged — B-3', () => {
  it('flips exactly the named entry; unknown ids are ignored', () => {
    const h = [
      { id: 'i1', type: 'instruction' as const, message: 'a', timestamp: 1, deliveryState: 'delivered' as const, deliveredAt: 2 },
      { id: 'i2', type: 'instruction' as const, message: 'b', timestamp: 1, deliveryState: 'delivered' as const, deliveredAt: 2 },
    ];
    const out = markInstructionsAcknowledged(h, ['i2', 'nope'], 700);
    expect(out[0].deliveryState).toBe('delivered');
    expect(out[1]).toMatchObject({ deliveryState: 'acknowledged', acknowledgedAt: 700, deliveredAt: 2 });
  });

  it('an entry acknowledged straight from the queue gets a deliveredAt too', () => {
    const h = [{ id: 'i1', type: 'instruction' as const, message: 'a', timestamp: 1, deliveryState: 'pending' as const }];
    expect(markInstructionsAcknowledged(h, ['i1'], 50)[0]).toMatchObject({ deliveryState: 'acknowledged', deliveredAt: 50, acknowledgedAt: 50 });
  });
});

describe('pendingInstructionIds', () => {
  it('names the pending entries whose text is in the served queue', () => {
    const h = [
      { id: 'i1', type: 'instruction' as const, message: 'one', timestamp: 1, deliveryState: 'delivered' as const },
      { id: 'i2', type: 'instruction' as const, message: 'two', timestamp: 2, deliveryState: 'pending' as const },
      { id: 'i3', type: 'instruction' as const, timestamp: 3, deliveryState: 'pending' as const }, // sensitive
      { type: 'instruction' as const, message: 'three', timestamp: 4, deliveryState: 'pending' as const }, // pre-id entry
      { id: 'i5', type: 'instruction' as const, message: 'gone', timestamp: 5, deliveryState: 'pending' as const },
    ];
    expect(pendingInstructionIds(h, 'two\n\nthree')).toEqual(['i2', 'i3']);
  });
});

describe('queueInstruction', () => {
  const base = { instructionHistory: [], pendingInstructions: null, turns: 3, status: 'running', runner: 'r1', supportsInstructionAck: true };

  it('queues for an ack-capable runner, any priority, without a Pusher text payload', () => {
    for (const priority of ['normal', 'urgent'] as const) {
      const q = queueInstruction(base, { message: 'go', isSensitive: false, priority });
      expect(q.queueable).toBe(true);
      expect(q.deliveryState).toBe('pending');
      expect(q.pendingInstructions).toBe('go');
      expect(q.pusherText).toBeNull();
      expect(q.instructionHistory.at(-1)).toMatchObject({ id: q.id, message: 'go', deliveryState: 'pending', turnAtSend: 3 });
    }
  });

  it('appends to an existing queue rather than replacing it', () => {
    expect(queueInstruction({ ...base, pendingInstructions: 'a' }, { message: 'b', isSensitive: false }).pendingInstructions).toBe('a\n\nb');
  });

  it('a legacy runner (no ack) still gets the text over Pusher', () => {
    const q = queueInstruction({ ...base, supportsInstructionAck: false }, { message: 'go', isSensitive: false, priority: 'urgent' });
    expect(q.pusherText).toBe('go');
    expect(q.queueable).toBe(false);
    expect(q.deliveryState).toBe('delivered');
  });

  it('an interactive worker is ack-capable from the start', () => {
    const q = queueInstruction({ ...base, supportsInstructionAck: false, runner: 'mcp' }, { message: 'go', isSensitive: false });
    expect(q.queueable).toBe(true);
    expect(q.pusherText).toBeNull();
  });

  it('a terminal worker queues nothing; urgent text still goes to a session the runner may hold', () => {
    const q = queueInstruction({ ...base, status: 'error' }, { message: 'go', isSensitive: false, priority: 'urgent' });
    expect(q.queueable).toBe(false);
    expect(q.pendingInstructions).toBeNull();
    expect(q.pusherText).toBe('go');
  });
});
