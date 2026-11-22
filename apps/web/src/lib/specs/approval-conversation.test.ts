import { describe, expect, it } from 'bun:test';
import { parseCriterionSources, verifyOwnerMessage, type ConversationMessageRow } from './approval-conversation';

const C = '11111111-1111-4111-8111-111111111111';
const M = '22222222-2222-4222-8222-222222222222';
const revAt = new Date('2026-01-01T10:00:00Z');
const row = (over: Partial<ConversationMessageRow> = {}): ConversationMessageRow => ({
  conversationOwnerId: 'owner', messageConversationId: C, role: 'user', authorUserId: 'owner', createdAt: new Date('2026-01-01T10:05:00Z'), ...over,
});
const loader = (r: ConversationMessageRow | null) => async () => r;

describe('verifyOwnerMessage', () => {
  it('accepts the owner\'s own message and returns its provenance', async () => {
    const r = await verifyOwnerMessage('owner', { conversationId: C, messageId: M }, revAt, loader(row()));
    expect(r).toEqual({ ok: true, provenance: { conversationId: C, messageId: M, messageAt: new Date('2026-01-01T10:05:00Z') } });
  });
  it('refuses a message someone else authored', async () => {
    const r = await verifyOwnerMessage('owner', { conversationId: C, messageId: M }, revAt, loader(row({ authorUserId: 'other' })));
    expect(r).toMatchObject({ ok: false, status: 403, code: 'message_not_yours' });
  });
  it('refuses an assistant message, an agent-authored (null author) one, and a conversation owned by another', async () => {
    for (const over of [{ role: 'assistant' }, { authorUserId: null }, { conversationOwnerId: 'other' }]) {
      expect(await verifyOwnerMessage('owner', { conversationId: C, messageId: M }, revAt, loader(row(over)))).toMatchObject({ ok: false, status: 403 });
    }
  });
  it('refuses a forged ref that matches nothing, and a message from another conversation', async () => {
    expect(await verifyOwnerMessage('owner', { conversationId: C, messageId: M }, revAt, loader(null))).toMatchObject({ ok: false, status: 403 });
    expect(await verifyOwnerMessage('owner', { conversationId: C, messageId: M }, revAt, loader(row({ messageConversationId: M })))).toMatchObject({ ok: false, status: 403 });
  });
  it('refuses a message written before the revision existed', async () => {
    const r = await verifyOwnerMessage('owner', { conversationId: C, messageId: M }, revAt, loader(row({ createdAt: new Date('2026-01-01T09:00:00Z') })));
    expect(r).toMatchObject({ ok: false, status: 409, code: 'message_predates_revision' });
  });
  it('400s on a ref that is not ids', async () => {
    expect(await verifyOwnerMessage('owner', { conversationId: 'x', messageId: M }, revAt, loader(row()))).toMatchObject({ ok: false, status: 400 });
  });
});

describe('parseCriterionSources', () => {
  it('reads a map, null for none, refuses bad ids', () => {
    expect(parseCriterionSources({ 'R-1': ' "approve the refund rule" ' })).toEqual({ ok: true, sources: { 'R-1': '"approve the refund rule"' } });
    expect(parseCriterionSources(undefined)).toEqual({ ok: true, sources: null });
    expect(parseCriterionSources({ foo: 'x' })).toMatchObject({ ok: false, status: 400 });
    expect(parseCriterionSources({ 'R-1': '' })).toMatchObject({ ok: false, status: 400 });
  });
});
