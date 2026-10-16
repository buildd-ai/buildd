import { describe, expect, it, mock } from 'bun:test';
import { NextRequest } from 'next/server';

mock.module('@/lib/specs/caller', () => ({ specCaller: async () => ({ kind: 'user', userId: 'u1' }) }));
const created: unknown[] = [];
mock.module('@/lib/specs/store', () => ({
  listSpecs: async () => ({ ok: true, specs: [] }),
  author: () => ({ label: 'u1' }),
  createSpecDraft: async (_c: unknown, input: { body: string }) => {
    created.push(input);
    return { ok: true, spec: { id: 's1', workspaceId: 'w1', title: 'T', parentSpecId: 'p1' }, revision: { revision: 1 }, duplicateCheck: null };
  },
}));
mock.module('@/lib/specs/neighbours', () => ({ suggestParent: async () => null }));
mock.module('@/lib/specs/organize', () => ({ organizeNewSpec: async () => undefined }));
const { POST } = await import('./route');

const post = (body: object) => POST(new NextRequest('http://l/api/specs', { method: 'POST', body: JSON.stringify(body) }));

describe('POST /api/specs formatHints (R-48, AC-36)', () => {
  it('a five-step numbered flow with no diagram gets a diagram hint, and the draft is still created unchanged', async () => {
    const body = '1. Open\n2. Pick\n3. Pay\n4. Confirm\n5. Receipt';
    const res = await post({ workspaceId: 'w1', title: 'T', body });
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.spec.id).toBe('s1');
    expect(json.formatHints.map((h: { kind: string }) => h.kind)).toEqual(['diagram']);
    expect((created.at(-1) as { body: string }).body).toBe(body);
  });

  it('plain prose gets an empty list', async () => {
    expect((await (await post({ workspaceId: 'w1', title: 'T', body: 'R-1 It works.' })).json()).formatHints).toEqual([]);
  });
});
