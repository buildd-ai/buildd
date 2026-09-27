import { describe, expect, it } from 'bun:test';
import { appendInstructionHistory, messageDeliveryStatus } from './worker-instructions';

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
  it('not yet confirmed delivered: sent, regardless of turns', () => {
    expect(messageDeliveryStatus({ deliveryState: 'pending', turnAtSend: 3 }, 10)).toEqual({ state: 'sent' });
    expect(messageDeliveryStatus({ deliveryState: undefined, turnAtSend: 3 }, 10)).toEqual({ state: 'sent' });
  });

  it('delivered, but the worker has not turned since: delivered', () => {
    expect(messageDeliveryStatus({ deliveryState: 'delivered', turnAtSend: 5 }, 5)).toEqual({ state: 'delivered' });
    expect(messageDeliveryStatus({ deliveryState: 'delivered', turnAtSend: 5 }, 4)).toEqual({ state: 'delivered' });
  });

  it('delivered, and the worker has taken a turn since: read at turnAtSend + 1', () => {
    expect(messageDeliveryStatus({ deliveryState: 'delivered', turnAtSend: 5 }, 6)).toEqual({ state: 'read', turn: 6 });
    // The label is fixed at the first turn that could have read it, not the
    // live count — it doesn't keep climbing as the worker keeps going.
    expect(messageDeliveryStatus({ deliveryState: 'delivered', turnAtSend: 5 }, 40)).toEqual({ state: 'read', turn: 6 });
  });

  it('no turn baseline (older entry, or an unknown current count): delivered, never read', () => {
    expect(messageDeliveryStatus({ deliveryState: 'delivered', turnAtSend: undefined }, 10)).toEqual({ state: 'delivered' });
    expect(messageDeliveryStatus({ deliveryState: 'delivered', turnAtSend: 5 }, null)).toEqual({ state: 'delivered' });
  });
});
