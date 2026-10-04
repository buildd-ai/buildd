/**
 * The merge SQL, rendered (PgDialect): first value wins per key, scoped to
 * one conversation's user message with this client ref.
 */
import { describe, expect, it, mock } from 'bun:test';

const captured: { set?: any; where?: unknown } = {};
mock.module('@buildd/core/db', () => ({
  db: {
    update: () => ({
      set: (s: any) => { captured.set = s; return {
        where: (w: unknown) => { captured.where = w; return { returning: async () => [{ id: 'm1' }] }; },
      }; },
    }),
  },
}));

const { PgDialect } = await import('drizzle-orm/pg-core');
const { recordTurnSignal, turnRowWhere } = await import('./turn-signal-store');
const { mergeTurnSignal } = await import('./turn-signal');
const render = (w: unknown) => new PgDialect().sqlToQuery(w as any);

describe('recordTurnSignal', () => {
  it('matches only this conversation\'s user message carrying the ref', () => {
    const q = render(turnRowWhere('conv-1', 'msg_1'));
    expect(q.sql).toContain('"conversation_messages"."conversation_id" = $1');
    expect(q.sql).toContain('"conversation_messages"."role" = $2');
    expect(q.sql).toContain(`"conversation_messages"."usage" -> 'turn' ->> 'ref' = $3`);
    expect(q.params).toEqual(['conv-1', 'user', 'msg_1']);
  });

  it('merges incoming || existing, so the existing (first) value wins, as mergeTurnSignal does', async () => {
    expect(await recordTurnSignal('conv-1', 'msg_1', { endMs: 5 })).toBe(true);
    const q = render(captured.set.usage);
    expect(q.sql).toBe(`jsonb_set("conversation_messages"."usage", '{turn}', $1::jsonb || coalesce("conversation_messages"."usage" -> 'turn', '{}'::jsonb))`);
    expect(q.params).toEqual([JSON.stringify({ endMs: 5 })]);
    // The executable spec of that SQL.
    expect(mergeTurnSignal({ ref: 'msg_1', endMs: 1 }, { endMs: 5, renderMs: 2 })).toEqual({ ref: 'msg_1', endMs: 1, renderMs: 2 });
  });
});
