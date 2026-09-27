import { describe, it, expect } from 'bun:test';
import { renderChatContextBlock, zonedIsoWithOffset } from './context-block';

// A fixed instant: 2026-09-26 21:30:00 UTC is Sunday 10:30 in Auckland (NZDT, which starts that morning,
// +13:00) and Saturday 17:30 in New York (EDT, -04:00). Models read "today"
// from training data unless told, so the block must carry the real local date.
const NOW = new Date('2026-09-26T21:30:00.000Z');

describe('zonedIsoWithOffset', () => {
  it('renders local wall time with the zone offset and weekday', () => {
    expect(zonedIsoWithOffset(NOW, 'Pacific/Auckland')).toEqual({
      iso: '2026-09-27T10:30:00+13:00', weekday: 'Sunday', date: '2026-09-27',
    });
    expect(zonedIsoWithOffset(NOW, 'America/New_York')).toEqual({
      iso: '2026-09-26T17:30:00-04:00', weekday: 'Saturday', date: '2026-09-26',
    });
    expect(zonedIsoWithOffset(NOW, 'UTC').iso).toBe('2026-09-26T21:30:00+00:00');
  });

  it('handles half-hour offsets', () => {
    expect(zonedIsoWithOffset(NOW, 'Asia/Kolkata').iso).toBe('2026-09-27T03:00:00+05:30');
  });
});

describe('renderChatContextBlock', () => {
  const base = {
    now: NOW,
    timeZone: 'Pacific/Auckland',
    conversationId: 'conv-1',
    workspace: { id: 'ws-1', name: 'billing-web' },
    user: { name: 'Sam', teamRole: 'member' as const, isOperator: false },
    tier: 'standard',
  };

  it('with a fixed clock and a non-UTC user, carries the user\'s local date, weekday and zone', () => {
    const block = renderChatContextBlock(base);
    expect(block).toContain('2026-09-27T10:30:00+13:00');
    expect(block).toContain('Sunday');
    expect(block).toContain('Pacific/Auckland');
    // The UTC date is a different day here; it must not be presented as "today".
    expect(block).not.toContain('2026-09-26');
  });

  it('carries the conversation id, workspace scope and role', () => {
    const block = renderChatContextBlock(base);
    expect(block).toContain('conv-1');
    expect(block).toContain('billing-web');
    expect(block).toContain('ws-1');
    expect(block).toContain('member');
  });

  it('says so when the conversation has no default workspace', () => {
    const block = renderChatContextBlock({ ...base, workspace: null });
    expect(block.toLowerCase()).toContain('no default workspace');
  });

  it('all workspaces: lists them and says to name one or ask', () => {
    const block = renderChatContextBlock({
      ...base, workspace: null,
      workspaces: [{ id: 'ws-1', name: 'billing-web' }, { id: 'ws-2', name: 'docs-site' }],
    });
    expect(block).toContain('billing-web (id ws-1)');
    expect(block).toContain('docs-site (id ws-2)');
    expect(block.toLowerCase()).toContain('ask which one');
  });

  it('a routed workspace says it was picked from the message, not pinned', () => {
    const block = renderChatContextBlock({ ...base, workspace: { id: 'ws-1', name: 'billing-web', source: 'routed' } });
    expect(block).toContain('billing-web (id ws-1)');
    expect(block.toLowerCase()).toContain('picked from the message');
  });

  it('names the object the chat was opened from, by id, and how to read it', () => {
    const M = '11111111-1111-4111-8111-111111111111';
    const block = renderChatContextBlock({ ...base, entry: { about: { kind: 'mission', id: M } } });
    expect(block).toContain(`mission ${M}`);
    expect(block).toContain('manage_missions');
    expect(block).toContain('"this mission"');
    const task = renderChatContextBlock({ ...base, entry: { about: { kind: 'task', id: M } } });
    expect(task).toContain(`task ${M}`);
    expect(task).toContain('get_task');
  });

  it('says what the user came to file when they opened chat from New task or + Mission', () => {
    expect(renderChatContextBlock({ ...base, entry: { intent: 'task' } })).toContain('New task');
    expect(renderChatContextBlock({ ...base, entry: { intent: 'mission' } })).toContain('New mission');
    expect(renderChatContextBlock(base)).not.toContain('opened this chat');
  });

  it('adds the 80% budget note only when asked', () => {
    expect(renderChatContextBlock(base)).not.toContain('budget');
    expect(renderChatContextBlock({ ...base, budgetWarning: true }).toLowerCase()).toContain('80%');
  });
});
