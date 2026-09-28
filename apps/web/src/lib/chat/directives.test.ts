import { describe, it, expect } from 'bun:test';
import { CHAT_DIRECTIVE_PART_TYPE } from '@buildd/shared';
import { proposeDirectiveCard, withDirectiveCard } from './directives';

const WS = { id: 'aaaa0000-0000-0000-0000-000000000000', name: 'billing-web' };

async function drain<T>(s: ReadableStream<T>): Promise<T[]> {
  const out: T[] = [];
  const r = s.getReader();
  for (;;) {
    const { done, value } = await r.read();
    if (done) return out;
    out.push(value);
  }
}
const streamOf = <T,>(chunks: T[]) => new ReadableStream<T>({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });

describe('proposeDirectiveCard', () => {
  it('an ordinary turn never asks Jev', async () => {
    let asked = 0;
    const card = await proposeDirectiveCard({ conversationId: 'c-1', message: 'What is running?', workspace: null, judge: async () => { asked++; return null; } });
    expect(card).toBeNull();
    expect(asked).toBe(0);
  });

  it('a confident Jev directive with a workspace verdict preselects the workspace', async () => {
    const card = await proposeDirectiveCard({
      conversationId: 'c-1',
      message: 'Always run the billing smoke test before a PR.',
      workspace: WS,
      judge: async () => ({ tier: { choice: 'directive', confidence: 0.95 }, scope: { choice: 'workspace', confidence: 0.9 } }),
    });
    expect(card).toEqual({
      conversationId: 'c-1', text: 'Always run the billing smoke test before a PR.', suggestedScope: 'workspace', workspace: WS, source: 'jev',
    });
  });

  it('Jev unavailable: the keyword rule decides, default everywhere', async () => {
    const card = await proposeDirectiveCard({ conversationId: 'c-1', message: 'From now on, open PRs as drafts.', workspace: WS, judge: async () => null });
    expect(card).toMatchObject({ suggestedScope: 'everywhere', source: 'rule' });
  });

  it('Jev throwing or hanging fails open to the keyword rule', async () => {
    expect(await proposeDirectiveCard({ conversationId: 'c-1', message: 'Never force-push to dev.', workspace: null, judge: async () => { throw new Error('x'); } }))
      .toMatchObject({ source: 'rule' });
    const hung = await proposeDirectiveCard({
      conversationId: 'c-1',
      message: 'Never force-push to dev.', workspace: null, budgetMs: 20,
      judge: () => new Promise(() => {}),
    });
    expect(hung).toMatchObject({ source: 'rule' });
  });

  it('a confident "neither" suppresses the card the keyword rule would show', async () => {
    const card = await proposeDirectiveCard({
      conversationId: 'c-1',
      message: 'Never mind, always happy to wait.', workspace: null,
      judge: async () => ({ tier: { choice: 'neither', confidence: 0.9 }, scope: null }),
    });
    expect(card).toBeNull();
  });
});

describe('withDirectiveCard', () => {
  const data = { conversationId: 'c-1', text: 'Always x', suggestedScope: 'everywhere' as const, workspace: null, source: 'rule' as const };

  it('inserts the card just before finish', async () => {
    const out = await drain(withDirectiveCard(streamOf<any>([{ type: 'start' }, { type: 'text-delta' }, { type: 'finish' }]), Promise.resolve(data)));
    expect(out.map(c => c.type)).toEqual(['start', 'text-delta', CHAT_DIRECTIVE_PART_TYPE, 'finish']);
    expect(out[2].data).toEqual(data);
  });

  it('no card: passes through', async () => {
    const out = await drain(withDirectiveCard(streamOf<any>([{ type: 'start' }, { type: 'finish' }]), Promise.resolve(null)));
    expect(out.map(c => c.type)).toEqual(['start', 'finish']);
    const src = streamOf<any>([{ type: 'start' }]);
    expect(withDirectiveCard(src, null)).toBe(src);
  });

  it('a stream with no finish still gets its card, once', async () => {
    const out = await drain(withDirectiveCard(streamOf<any>([{ type: 'start' }]), Promise.resolve(data)));
    expect(out.map(c => c.type)).toEqual(['start', CHAT_DIRECTIVE_PART_TYPE]);
  });
});
