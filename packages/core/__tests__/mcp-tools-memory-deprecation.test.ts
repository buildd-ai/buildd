/**
 * buildd_memory deprecation telemetry.
 *
 * `buildd_memory` was superseded by `recall`/`learn` in #1944, but it stays
 * routed for compatibility (docs/design/knowledge-tool-surface.md step 6 is
 * "remove buildd_memory"). Removal needs evidence that nothing still calls it,
 * and the only signal available in production is the log stream — so every
 * dispatch emits one greppable line and bumps an in-process counter.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import {
  handleMemoryAction,
  getBuilddMemoryDeprecationCounts,
  resetBuilddMemoryDeprecationCounts,
  BUILDD_MEMORY_DEPRECATION_TAG,
} from '../mcp-tools';
import type { MemoryStore } from '../memory-store';

const WS_ID = 'aaaa0000-0000-0000-0000-000000000000';
const TEAM_ID = 'bbbb0000-0000-0000-0000-000000000000';

function fakeStore(): MemoryStore {
  return {
    async getContext() { return { markdown: '# digest' }; },
    async search() { return { results: [], total: 0 }; },
    async batch() { return { memories: [] }; },
    async save() { return { memory: { id: 'mem-1', title: 't', type: 'gotcha' } }; },
  } as unknown as MemoryStore;
}

const ctx = { workspaceId: WS_ID, teamId: TEAM_ID, workerId: 'worker-001' };

let warnings: string[];
const realWarn = console.warn;

beforeEach(() => {
  resetBuilddMemoryDeprecationCounts();
  warnings = [];
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')); };
});
afterEach(() => { console.warn = realWarn; });

describe('buildd_memory deprecation telemetry', () => {
  it('counts each call per action', async () => {
    await handleMemoryAction(fakeStore(), 'search', { query: 'x' }, ctx);
    await handleMemoryAction(fakeStore(), 'search', { query: 'y' }, ctx);
    await handleMemoryAction(fakeStore(), 'context', {}, ctx);
    expect(getBuilddMemoryDeprecationCounts()).toEqual({ search: 2, context: 1 });
  });

  it('emits one greppable line per call, tagged and attributed', async () => {
    await handleMemoryAction(fakeStore(), 'search', { query: 'x' }, ctx);
    expect(warnings).toHaveLength(1);
    const line = warnings[0];
    expect(line).toContain(BUILDD_MEMORY_DEPRECATION_TAG);
    expect(line).toContain('action=search');
    expect(line).toContain(`workspace=${WS_ID}`);
    // Single line — multi-line output breaks log grepping.
    expect(line.includes('\n')).toBe(false);
  });

  it('names the replacement so the log says what to migrate to', async () => {
    await handleMemoryAction(fakeStore(), 'save', { title: 't', type: 'gotcha', content: 'c' }, ctx);
    expect(warnings[0]).toMatch(/recall|learn/);
  });

  it('counts admin-gated actions that are NOT deprecated separately from the rest', async () => {
    // consolidate_knowledge / query_knowledge were promoted to the `buildd`
    // admin action set, not deprecated — but they still arrive through this
    // dispatcher, so they must not pollute the deprecation signal.
    await handleMemoryAction(null, 'query_knowledge', { query: 'x' }, ctx).catch(() => {});
    expect(getBuilddMemoryDeprecationCounts().query_knowledge).toBeUndefined();
    expect(warnings).toHaveLength(0);
  });

  it('does not throw when the counter is read before any call', () => {
    expect(getBuilddMemoryDeprecationCounts()).toEqual({});
  });
});
