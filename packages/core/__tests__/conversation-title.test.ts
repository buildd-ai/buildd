import { describe, it, expect } from 'bun:test';
import { conversationDisplayTitle, normalizeConversationTitle, CONVERSATION_TITLE_MAX } from '../conversation-title';

describe('conversationDisplayTitle', () => {
  it('never returns empty: an untitled conversation reads "New conversation"', () => {
    expect(conversationDisplayTitle({ title: null })).toBe('New conversation');
    expect(conversationDisplayTitle({ title: '   ' })).toBe('New conversation');
    expect(conversationDisplayTitle({ title: 'Billing in local currency' })).toBe('Billing in local currency');
  });
});

describe('normalizeConversationTitle', () => {
  it('collapses whitespace, strips wrapping quotes and a trailing period, and fits the column', () => {
    expect(normalizeConversationTitle('  "Billing   in\nlocal currency."  ')).toBe('Billing in local currency');
    const long = 'x'.repeat(200);
    expect(normalizeConversationTitle(long)!.length).toBeLessThanOrEqual(CONVERSATION_TITLE_MAX);
  });

  it('returns null for nothing usable', () => {
    expect(normalizeConversationTitle('  ')).toBeNull();
    expect(normalizeConversationTitle('""')).toBeNull();
    expect(normalizeConversationTitle(undefined)).toBeNull();
  });
});
