import { describe, it, expect, mock, beforeEach } from 'bun:test';

// Mock drizzle-orm's `sql` tag BEFORE mcp-tools is loaded — identical shape to
// the mock in knowledge-supersession.test.ts (bun's mock.module is
// process-global; keeping the shape identical makes full-suite and standalone
// runs behave the same).
mock.module('drizzle-orm', () => ({
  sql: Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => ({ _sql: true, strings, values }),
    { join: (parts: unknown[]) => ({ _sql: true, parts }) },
  ),
}));

// ── Recording DB mock ─────────────────────────────────────────────────────────

interface Executed {
  text: string;
  values: unknown[];
}

let executed: Executed[] = [];
let responder: (text: string) => { rows: Array<Record<string, unknown>> } = () => ({ rows: [] });

function flattenSql(q: any): string {
  if (q === null || q === undefined) return '';
  if (typeof q !== 'object') return JSON.stringify(q);
  if (Array.isArray(q.parts)) return q.parts.map(flattenSql).join(', ');
  if (q.strings) {
    let out = '';
    const strings: string[] = Array.from(q.strings);
    const values: unknown[] = q.values ?? [];
    strings.forEach((s, i) => {
      out += s;
      if (i < values.length) {
        const v: any = values[i];
        out += v && typeof v === 'object' && (v.strings || v.parts) ? flattenSql(v) : JSON.stringify(v);
      }
    });
    return out;
  }
  return '';
}

function collectValues(q: any, acc: unknown[] = []): unknown[] {
  if (q === null || q === undefined || typeof q !== 'object') {
    acc.push(q);
    return acc;
  }
  if (Array.isArray(q.parts)) {
    for (const p of q.parts) collectValues(p, acc);
    return acc;
  }
  if (q.strings) {
    for (const v of q.values ?? []) collectValues(v, acc);
    return acc;
  }
  acc.push(q);
  return acc;
}

mock.module('../db/index', () => ({
  db: {
    execute: (q: unknown) => {
      const text = flattenSql(q);
      executed.push({ text, values: collectValues(q) });
      return Promise.resolve(responder(text));
    },
  },
}));

const { handleMemoryAction, memoryActions, adminActions } = await import('../mcp-tools');

const WS = '00000000-0000-0000-0000-000000000001';
const TEAM = '00000000-0000-0000-0000-0000000000aa';

const memoryClient = {} as any; // consolidate_knowledge never touches the memory service

function ctx(over: Record<string, unknown> = {}) {
  return { workerId: 'w-1', workspaceId: WS, teamId: TEAM, embedder: null, ...over };
}

beforeEach(() => {
  executed = [];
  responder = () => ({ rows: [] });
});

describe('buildd_memory consolidate_knowledge', () => {
  it('is a registered admin action (moved from memoryActions)', () => {
    expect(adminActions).toContain('consolidate_knowledge');
    expect(memoryActions).not.toContain('consolidate_knowledge');
  });

  it('requires op', async () => {
    await expect(
      handleMemoryAction(memoryClient, 'consolidate_knowledge', {}, ctx()),
    ).rejects.toThrow(/op/);
  });

  it('rejects unknown ops', async () => {
    await expect(
      handleMemoryAction(memoryClient, 'consolidate_knowledge', { op: 'obliterate' }, ctx()),
    ).rejects.toThrow(/op/);
  });

  describe('op=find_duplicates', () => {
    it('queries team memory + workspace task namespaces by default and reports pairs', async () => {
      responder = () => ({
        rows: [{
          namespace: `${TEAM}:memory`,
          source_id_a: 'mem-1',
          source_id_b: 'mem-2',
          similarity: '0.955',
          preview_a: 'a', preview_b: 'b',
          source_ts_a: null, source_ts_b: null,
          hit_count_a: 3, hit_count_b: 0,
        }],
      });

      const res = await handleMemoryAction(memoryClient, 'consolidate_knowledge', { op: 'find_duplicates' }, ctx());

      expect(executed).toHaveLength(1);
      expect(executed[0].values).toContain(`${TEAM}:memory`);
      expect(executed[0].values).toContain(`${WS}:task`);

      const out = res.content[0].text;
      expect(out).toContain('mem-1');
      expect(out).toContain('mem-2');
      expect(out).toContain('0.955');
    });

    it('scopes to caller-provided corpora', async () => {
      await handleMemoryAction(
        memoryClient, 'consolidate_knowledge',
        { op: 'find_duplicates', corpora: ['task'] },
        ctx(),
      );
      expect(executed[0].values).toContain(`${WS}:task`);
      expect(executed[0].values).not.toContain(`${TEAM}:memory`);
    });

    it('drops the memory corpus when the caller has no teamId', async () => {
      await handleMemoryAction(memoryClient, 'consolidate_knowledge', { op: 'find_duplicates' }, ctx({ teamId: undefined }));
      expect(executed[0].values).toContain(`${WS}:task`);
      const nsValues = executed[0].values.filter(v => typeof v === 'string' && String(v).endsWith(':memory'));
      expect(nsValues).toEqual([]);
    });

    it('errors when no namespace is resolvable', async () => {
      await expect(
        handleMemoryAction(
          memoryClient, 'consolidate_knowledge',
          { op: 'find_duplicates', corpora: ['memory'] },
          ctx({ teamId: undefined }),
        ),
      ).rejects.toThrow(/namespace|teamId|workspaceId/i);
    });

    it('reports cleanly when no near-duplicates are found', async () => {
      const res = await handleMemoryAction(memoryClient, 'consolidate_knowledge', { op: 'find_duplicates' }, ctx());
      expect(res.content[0].text).toContain('No near-duplicate');
    });
  });

  describe('op=find_decayed', () => {
    it('queries workspace task + artifact namespaces by default and reports candidates', async () => {
      responder = () => ({
        rows: [{
          namespace: `${WS}:task`,
          source_id: 'task:t-9',
          corpus: 'task',
          source_ts: '2025-01-01T00:00:00.000Z',
          hit_count: 0,
          preview: 'stale',
        }],
      });

      const res = await handleMemoryAction(memoryClient, 'consolidate_knowledge', { op: 'find_decayed' }, ctx());

      expect(executed[0].values).toContain(`${WS}:task`);
      expect(executed[0].values).toContain(`${WS}:artifact`);
      expect(res.content[0].text).toContain('task:t-9');
    });

    it('reports cleanly when nothing has decayed', async () => {
      const res = await handleMemoryAction(memoryClient, 'consolidate_knowledge', { op: 'find_decayed' }, ctx());
      expect(res.content[0].text).toContain('No decayed');
    });
  });

  describe('op=archive', () => {
    it('requires corpus and sourceIds', async () => {
      await expect(
        handleMemoryAction(memoryClient, 'consolidate_knowledge', { op: 'archive' }, ctx()),
      ).rejects.toThrow(/corpus|sourceIds/);
      await expect(
        handleMemoryAction(memoryClient, 'consolidate_knowledge', { op: 'archive', corpus: 'task' }, ctx()),
      ).rejects.toThrow(/sourceIds/);
    });

    it('archives the listed source ids in the resolved namespace', async () => {
      responder = (text) =>
        text.includes('UPDATE knowledge_chunks')
          ? { rows: [{ source_id: 'task:t-1' }] }
          : { rows: [] };

      const res = await handleMemoryAction(
        memoryClient, 'consolidate_knowledge',
        { op: 'archive', corpus: 'task', sourceIds: ['task:t-1', 'task:t-gone'] },
        ctx(),
      );

      const upd = executed.find(e => e.text.includes('UPDATE knowledge_chunks'));
      expect(upd).toBeDefined();
      expect(upd!.values).toContain(`${WS}:task`);
      expect(upd!.text).toContain('is_current = false');
      expect(res.content[0].text).toContain('Archived 1');
      expect(res.content[0].text).toContain('task:t-1');
    });
  });
});
