/**
 * Turn-boundary acknowledgement on the runner (audit §2.3 steps 3–4).
 *
 * Delivered = the runner put the text in the session's input stream.
 * Acknowledged = the agent's turn read it, observed from the session itself:
 *   - Claude: the first assistant frame whose `user_message_uuid(s)` names the
 *     uuid we gave the injected SDKUserMessage;
 *   - Codex: the backend starting the turn whose prompt the message is;
 *   - an AskUserQuestion answer (a tool_result, never echoed) or a resumed
 *     session's prompt: the next top-level assistant frame.
 *
 * Run: bun run scripts/run-unit-tests.ts apps/runner/__tests__/unit/instruction-acks.test.ts
 */
import { describe, test, expect } from 'bun:test';
import { InstructionAckTracker, injectionUuid } from '../../src/instruction-acks';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe('injectionUuid', () => {
  test('a single message id is the SDK uuid (B-7)', () => {
    const id = '0a1b2c3d-1111-4222-8333-444455556666';
    expect(injectionUuid([id])).toBe(id);
  });

  test('several ids (one served payload) get one fresh uuid', () => {
    const u = injectionUuid(['0a1b2c3d-1111-4222-8333-444455556666', 'note-x']);
    expect(u).toMatch(UUID_RE);
    expect(u).not.toBe('0a1b2c3d-1111-4222-8333-444455556666');
  });

  test('a non-UUID single id is not passed through as a uuid', () => {
    expect(injectionUuid(['note-x'])).toMatch(UUID_RE);
  });
});

describe('InstructionAckTracker', () => {
  test('B-7: an assistant frame echoing the uuid acknowledges exactly once', () => {
    const t = new InstructionAckTracker();
    const uuid = t.register('w1', ['m-1'], { uuid: 'u-1' });
    expect(uuid).toBe('u-1');

    expect(t.onAssistant('w1', { type: 'assistant', parent_tool_use_id: null })).toEqual([]);
    expect(t.onAssistant('w1', { type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'u-1' })).toEqual(['m-1']);
    // Second frame of the same turn: already acked.
    expect(t.onAssistant('w1', { type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'u-1' })).toEqual([]);
  });

  test('a folded message found anywhere in user_message_uuids', () => {
    const t = new InstructionAckTracker();
    t.register('w1', ['m-1', 'm-2'], { uuid: 'u-2' });
    expect(t.onAssistant('w1', { type: 'assistant', parent_tool_use_id: null, user_message_uuid: 'u-0', user_message_uuids: ['u-0', 'u-2'] }))
      .toEqual(['m-1', 'm-2']);
  });

  test('subagent frames never acknowledge', () => {
    const t = new InstructionAckTracker();
    t.register('w1', ['m-1'], { uuid: 'u-1', ackOnNextAssistant: true });
    expect(t.onAssistant('w1', { type: 'assistant', parent_tool_use_id: 'tool-9', user_message_uuid: 'u-1' })).toEqual([]);
  });

  test('a tool-result answer or a resume prompt is read by the next top-level assistant frame', () => {
    const t = new InstructionAckTracker();
    t.register('w1', ['m-ans'], { ackOnNextAssistant: true });
    expect(t.onAssistant('w1', { type: 'assistant', parent_tool_use_id: null })).toEqual(['m-ans']);
  });

  test('Codex: input consumed at the turn boundary acknowledges', () => {
    const t = new InstructionAckTracker();
    t.register('w1', ['m-1'], { uuid: 'u-1' });
    expect(t.onInputConsumed('w1', ['u-1'])).toEqual(['m-1']);
    expect(t.onInputConsumed('w1', ['u-1'])).toEqual([]);
  });

  test('workers are independent and forget() drops what a dead session never read', () => {
    const t = new InstructionAckTracker();
    t.register('w1', ['a'], { uuid: 'u-a' });
    t.register('w2', ['b'], { uuid: 'u-b' });
    expect(t.onInputConsumed('w1', ['u-b'])).toEqual([]);
    t.forget('w2');
    expect(t.onInputConsumed('w2', ['u-b'])).toEqual([]);
  });

  test('no ids: nothing tracked', () => {
    const t = new InstructionAckTracker();
    t.register('w1', [], { uuid: 'u-1' });
    expect(t.onInputConsumed('w1', ['u-1'])).toEqual([]);
  });
});
