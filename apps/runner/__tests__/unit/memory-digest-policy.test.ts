import { describe, expect, test } from 'bun:test';
import {
  MEMORY_DIGEST_POLICY_VERSION,
  appendPromptCompositionEvent,
  buildMemoryBlock,
  buildPromptCompositionRecord,
} from '../../src/memory-digest-policy';

const obs = (n: number) => Array.from({ length: n }, (_, i) => ({
  type: 'gotcha',
  title: `lesson ${i}`,
  content: `content ${i}`,
}));

describe('buildMemoryBlock', () => {
  test('renders the header, task matches and the recall pointer, in that order', () => {
    const r = buildMemoryBlock({
      compactResult: { count: 3, markdown: 'DIGEST BODY' },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    });
    const block = r.block!;
    expect(block.indexOf('## Workspace Memory')).toBe(0);
    expect(block.indexOf('### Relevant to This Task')).toBeGreaterThan(0);
    expect(block.indexOf('Use `recall')).toBeGreaterThan(block.indexOf('### Relevant to This Task'));
  });

  // The workspace-wide digest is never rendered — the concluded experiment's
  // treatment is the only behaviour now. See workspace-memory-digest-arm.md.
  test('never renders the workspace-wide digest markdown', () => {
    const r = buildMemoryBlock({
      compactResult: { count: 3, markdown: 'DIGEST BODY' },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    });
    expect(r.block).not.toContain('DIGEST BODY');
    expect(r.digestBytes).toBe(0);
    expect(r.digestTruncated).toBe(false);
  });

  test('reports what the digest would have cost, for continued visibility', () => {
    const r = buildMemoryBlock({
      compactResult: { count: 3, markdown: 'DIGEST BODY' },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.digestBytesAvailable).toBe(Buffer.byteLength('DIGEST BODY', 'utf8'));
  });

  test('truncates each task match at the per-observation cap', () => {
    const r = buildMemoryBlock({
      compactResult: { count: 1, markdown: '' },
      taskSearchResults: [{ id: '1' }],
      fullObservations: [{ type: 'gotcha', title: 't', content: 'y'.repeat(500) }],
    });
    expect(r.block).toContain('y'.repeat(300) + '...');
    expect(r.block).not.toContain('y'.repeat(301));
  });

  test('renders nothing when the workspace has no memory and nothing matched', () => {
    const r = buildMemoryBlock({
      compactResult: { count: 0 },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.block).toBeNull();
    expect(r.digestBytes).toBe(0);
  });

  test('keeps the task-specific matches', () => {
    const r = buildMemoryBlock({
      compactResult: { count: 3, markdown: 'DIGEST' },
      taskSearchResults: [{ id: '1' }, { id: '2' }],
      fullObservations: obs(2),
    });
    expect(r.taskMatchCount).toBe(2);
    expect(r.block).toContain('- **[gotcha] lesson 0**: content 0');
    expect(r.block).toContain('- **[gotcha] lesson 1**: content 1');
  });

  // The pointer is behavioural instruction, not context. Dropping it would
  // change how often agents call `learn`.
  test('still advertises recall/learn when nothing matched the task', () => {
    const r = buildMemoryBlock({
      compactResult: { count: 12, markdown: 'DIGEST BODY' },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.block).toContain('Use `recall');
    expect(r.block).toContain('Use `learn`');
    expect(r.block).not.toContain('DIGEST BODY');
    expect(r.block).not.toContain('### Relevant to This Task');
  });

  test('the header carries the count, and agrees with itself on plurals', () => {
    expect(buildMemoryBlock({ compactResult: { count: 1, markdown: 'x' }, taskSearchResults: [], fullObservations: [] }).block)
      .toContain('## Workspace Memory (1 memory)');
    expect(buildMemoryBlock({ compactResult: { count: 40, markdown: 'x' }, taskSearchResults: [], fullObservations: [] }).block)
      .toContain('## Workspace Memory (40 memories)');
  });
});

describe('buildPromptCompositionRecord', () => {
  test('measures the memory block as a share of the whole prompt', () => {
    const memory = buildMemoryBlock({
      compactResult: { count: 3, markdown: 'D'.repeat(100) },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    });
    const promptText = 'P'.repeat(1000) + memory.block;
    const rec = buildPromptCompositionRecord({ memory, promptText });
    expect(rec.promptBytes).toBe(Buffer.byteLength(promptText, 'utf8'));
    expect(rec.memoryBlockBytes).toBe(Buffer.byteLength(memory.block!, 'utf8'));
    expect(rec.memoryShare).toBeCloseTo(rec.memoryBlockBytes / rec.promptBytes, 3);
  });

  test('counts bytes, not code units, so non-ASCII memory is not understated', () => {
    const memory = buildMemoryBlock({
      compactResult: { count: 1, markdown: '→'.repeat(50) },
      taskSearchResults: [],
      fullObservations: [],
    });
    // U+2192 is three bytes in UTF-8; a length-based count would report 50.
    expect(memory.digestBytesAvailable).toBeGreaterThanOrEqual(150);
  });

  test('a record carries the fixed arm, propensity and policy version', () => {
    const memory = buildMemoryBlock({
      compactResult: { count: 1, markdown: 'D' },
      taskSearchResults: [],
      fullObservations: [],
    });
    const rec = buildPromptCompositionRecord({ memory, promptText: 'prompt' });
    expect(rec.arm).toBe('task_scoped');
    expect(rec.propensity).toBe(1);
    expect(rec.fraction).toBe(1);
    expect(rec.policyVersion).toBe(MEMORY_DIGEST_POLICY_VERSION);
  });

  test('memoryShare is 0 rather than NaN for an empty prompt', () => {
    const rec = buildPromptCompositionRecord({
      memory: buildMemoryBlock({ compactResult: { count: 0 }, taskSearchResults: [], fullObservations: [] }),
      promptText: '',
    });
    expect(rec.memoryShare).toBe(0);
    expect(Number.isNaN(rec.memoryShare)).toBe(false);
  });
});

describe('appendPromptCompositionEvent', () => {
  const record = () => buildPromptCompositionRecord({
    memory: buildMemoryBlock({ compactResult: { count: 1, markdown: 'D' }, taskSearchResults: [], fullObservations: [] }),
    promptText: 'prompt',
  });

  test('starts at buildIndex 0 for an undefined counter and buffer', () => {
    const { buffer, nextBuildIndex } = appendPromptCompositionEvent(undefined, undefined, record(), 1000);
    expect(buffer).toHaveLength(1);
    expect(buffer[0].buildIndex).toBe(0);
    expect(buffer[0].ts).toBe(1000);
    expect(nextBuildIndex).toBe(1);
  });

  test('appends without mutating the input buffer, and advances the counter', () => {
    const first = appendPromptCompositionEvent(undefined, undefined, record(), 1000);
    const second = appendPromptCompositionEvent(first.buffer, first.nextBuildIndex, record(), 2000);

    expect(first.buffer).toHaveLength(1);
    expect(second.buffer).toHaveLength(2);
    expect(second.buffer.map(e => e.buildIndex)).toEqual([0, 1]);
    expect(second.nextBuildIndex).toBe(2);
  });

  test('a rebuilt session (e.g. bwrap-retry restart) does not reuse buildIndex 0', () => {
    // currentBuildIndex threaded through explicitly, as workers.ts does via
    // worker.promptBuildIndex — simulates a second startSession call on the
    // same worker after the first already emitted buildIndex 0.
    const { buffer, nextBuildIndex } = appendPromptCompositionEvent([], 1, record(), 3000);
    expect(buffer[0].buildIndex).toBe(1);
    expect(nextBuildIndex).toBe(2);
  });

  test('carries every PromptCompositionRecord field through onto the event', () => {
    const rec = record();
    const { buffer } = appendPromptCompositionEvent(undefined, undefined, rec, 1000);
    expect(buffer[0]).toMatchObject(rec);
  });
});
