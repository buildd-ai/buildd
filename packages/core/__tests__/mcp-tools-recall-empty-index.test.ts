/**
 * An empty recall result for code/docs must not claim "no index" when the
 * namespace holds chunks — the session hint counts the same namespace.
 */
import { describe, it, expect } from 'bun:test';
import { handleRecallAction } from '../mcp-tools';
import type { KnowledgeStore } from '../knowledge-store/types';

const WS_ID = 'bbbb0000-0000-0000-0000-000000000000';
const TEAM_ID = 'cccc0000-0000-0000-0000-000000000000';
const memClient = { batch: async () => ({ memories: [] }) } as any;
const body = (r: any) => r.content[0].text as string;

const storeWith = (count: number): KnowledgeStore => ({
  async query() { return []; },
  async upsert() {},
  async delete() {},
  async listNamespaces() { return []; },
  async countNamespace() { return count; },
});
const ctx = (s: KnowledgeStore) => ({
  workspaceId: WS_ID, teamId: TEAM_ID, project: 'acme/widgets', knowledgeStore: s, embedder: null as any,
});

describe('recall empty code/docs result', () => {
  it('indexed namespace with no match says so, not "run ingestion"', async () => {
    const res = await handleRecallAction(memClient, { query: 'dependency-manifest', scope: 'code' }, ctx(storeWith(42)));
    expect(body(res)).toContain('No code match');
    expect(body(res)).not.toContain('Run ingestion');
  });

  it('empty namespace still points at ingestion', async () => {
    const res = await handleRecallAction(memClient, { query: 'x', scope: 'code' }, ctx(storeWith(0)));
    expect(body(res)).toContain('Run ingestion first');
  });
});
