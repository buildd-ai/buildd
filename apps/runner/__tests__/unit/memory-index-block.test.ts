/**
 * The runner's `## Workspace Memory` block under index injection (task
 * caa30c0f): one line per memory, deduped against the claim-time index the
 * same prompt already carries, charged to the same budget. Flag off is the
 * existing memory-digest-policy / memory-digest-prompt tests, unchanged.
 */
import { describe, expect, test } from 'bun:test';
import {
  MEMORY_DIGEST_POLICY_VERSION,
  MEMORY_INDEX_POLICY_VERSION,
  buildMemoryBlock,
  buildPromptCompositionRecord,
  memoryIndexWhyFor,
} from '../../src/memory-digest-policy';
import { MEMORY_INDEX_HEADER, memoryIndexEntriesTokens } from '@buildd/core/memory-claim-index';

const M1 = '1a2b3c4d-0000-4000-8000-000000000001';
const M2 = '2b3c4d5e-0000-4000-8000-000000000002';
const M3 = '3c4d5e6f-0000-4000-8000-000000000003';

const results = [
  { id: M1, type: 'gotcha', title: 'Neon has no transactions' },
  { id: M2, type: 'pattern', title: 'Use bun run test' },
];

describe('buildMemoryBlock, index mode', () => {
  test('renders the header and one line per task match, no bodies', () => {
    const r = buildMemoryBlock({
      compactResult: { count: 12 },
      taskSearchResults: results,
      fullObservations: [{ type: 'gotcha', title: 'Neon has no transactions', content: 'BODY TEXT' }],
      index: { budgetTokens: 800, why: 'path', claimEntries: [] },
    });
    expect(r.block).toBe([
      '## Workspace Memory (12 memories)',
      '### Relevant to This Task',
      MEMORY_INDEX_HEADER,
      '- gotcha m:1a2b3c4d Neon has no transactions (path)',
      '- pattern m:2b3c4d5e Use bun run test (path)',
      '\nUse `recall scope=["memory","task"]` for full context (prior lessons + recent outcomes in one call). Use `learn` to record gotchas/patterns/decisions — NOT summaries.',
    ].join('\n'));
    expect(r.block).not.toContain('BODY TEXT');
    expect(r.taskMatchCount).toBe(2);
    expect(r.mode).toBe('index');
  });

  test('skips what the claim-time index already showed and charges its tokens', () => {
    const claimEntries = [{ id: M1, type: 'gotcha', title: 'Neon has no transactions', why: 'title' as const }];
    const r = buildMemoryBlock({
      compactResult: { count: 3 },
      taskSearchResults: [...results, { id: M3, type: 'decision', title: 'Third' }],
      fullObservations: [],
      index: { budgetTokens: 800, why: 'title', claimEntries },
    });
    expect(r.block).not.toContain('m:1a2b3c4d');
    expect(r.block).toContain('- pattern m:2b3c4d5e Use bun run test (title)');
    expect(r.block).toContain('- decision m:3c4d5e6f Third (title)');
    expect(r.taskMatchCount).toBe(2);

    const tight = buildMemoryBlock({
      compactResult: { count: 3 },
      taskSearchResults: results,
      fullObservations: [],
      index: { budgetTokens: memoryIndexEntriesTokens(claimEntries) + 2, why: 'title', claimEntries },
    });
    expect(tight.block).not.toContain('m:2b3c4d5e');
    expect(tight.taskMatchCount).toBe(0);
  });

  test('maps the retrieval step to why', () => {
    expect(memoryIndexWhyFor('path_manifest')).toBe('path');
    expect(memoryIndexWhyFor('inferred_paths')).toBe('path');
    expect(memoryIndexWhyFor('predicted_area')).toBe('area');
    expect(memoryIndexWhyFor('title_phrase')).toBe('title');
  });

  test('the composition record carries its own policy version in index mode only', () => {
    const on = buildMemoryBlock({ compactResult: { count: 1 }, taskSearchResults: results, fullObservations: [], index: { budgetTokens: 800, why: 'path', claimEntries: [] } });
    const off = buildMemoryBlock({ compactResult: { count: 1 }, taskSearchResults: results, fullObservations: [] });
    expect(buildPromptCompositionRecord({ memory: on, promptText: 'x' }).policyVersion).toBe(MEMORY_INDEX_POLICY_VERSION);
    expect(buildPromptCompositionRecord({ memory: off, promptText: 'x' }).policyVersion).toBe(MEMORY_DIGEST_POLICY_VERSION);
    expect('mode' in off).toBe(false);
  });
});

describe('buildPromptWithComposition, index mode', () => {
  test('the prompt carries the index block when memoryIndex is passed, bodies otherwise', async () => {
    const { buildPromptWithComposition } = await import('../../src/prompt-builder');
    const base = {
      task: { id: 'task-1', title: 'Do the thing', description: 'Do the thing properly' },
      worker: { id: 'worker-1', workspaceName: 'demo' },
      isConfigured: false,
      compactResult: { count: 2 },
      taskSearchResults: results,
      fullObservations: [{ type: 'gotcha', title: 'Neon has no transactions', content: 'BODY TEXT' }],
      inputPolicy: 'autonomous',
      hasApiKey: true,
    } as any;
    const on = buildPromptWithComposition({ ...base, memoryIndex: { budgetTokens: 800, why: 'path', claimEntries: [] } });
    expect(on.promptText).toContain(`${MEMORY_INDEX_HEADER}\n- gotcha m:1a2b3c4d Neon has no transactions (path)`);
    expect(on.promptText).not.toContain('BODY TEXT');
    const off = buildPromptWithComposition(base);
    expect(off.promptText).toContain('BODY TEXT');
    expect(off.promptText).not.toContain(MEMORY_INDEX_HEADER);
  });
});
