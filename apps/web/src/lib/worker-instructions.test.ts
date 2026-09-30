import { describe, expect, it } from 'bun:test';
import { appendInstructionHistory, messageDeliveryStatus, isUnreachableWorkerStatus } from './worker-instructions';
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

describe('messageDeliveryStatus', () => {
  it('not yet confirmed delivered: sent', () => {
    expect(messageDeliveryStatus({ deliveryState: 'pending' })).toEqual({ state: 'sent' });
    expect(messageDeliveryStatus({ deliveryState: undefined })).toEqual({ state: 'sent' });
  });

  it('confirmed delivered: delivered, and nothing past it', () => {
    // workers.turns counts runner check-ins, not agent turns, so it can't back
    // a "read at turn N" claim. Delivered is the last state we can prove.
    expect(messageDeliveryStatus({ deliveryState: 'delivered' })).toEqual({ state: 'delivered' });
  });
});
