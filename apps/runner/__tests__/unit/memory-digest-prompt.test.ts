import { describe, expect, test } from 'bun:test';
import { buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * The workspace-memory block every prompt renders. Since
 * `docs/design/workspace-memory-digest-arm.md` concluded the memory-digest
 * experiment, this is the only rendering — there is no arm, no draw and no
 * fraction to configure. The workspace-wide digest is never included; only
 * the task-specific matches and the `recall`/`learn` pointer are.
 */

const RECALL_LINE =
  '\nUse `recall scope=["memory","task"]` for full context (prior lessons + recent outcomes in one call). Use `learn` to record gotchas/patterns/decisions — NOT summaries.';

/**
 * A digest shaped like the real one: `### <Type>s` subsections joined by blank
 * lines, whose bodies are user-authored markdown and can therefore contain
 * blank lines and headings of their own. It must never reach the prompt.
 */
const REALISTIC_DIGEST = [
  '### Gotchas',
  '- **the gotcha**: watch out',
  '',
  '### Patterns',
  '- **stray heading inside a memory body**: see below',
  '',
  '## Not the end of the block',
].join('\n');

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    task: { id: '510c4619-e02e-47bb-a018-e6336d1ff989', title: 'Do the thing', description: 'Do the thing properly' },
    worker: { id: 'worker-1', workspaceName: 'demo' },
    isConfigured: false,
    compactResult: { count: 2, markdown: '- prior lesson A\n- prior lesson B' },
    taskSearchResults: [{ id: 'obs-1' }],
    fullObservations: [{ type: 'gotcha', title: 'the gotcha', content: 'watch out' }],
    inputPolicy: 'autonomous',
    hasApiKey: true,
    ...overrides,
  } as any;
}

describe('workspace memory block', () => {
  test('renders task matches and the recall pointer, never the workspace-wide digest', () => {
    const built = buildPromptWithComposition(ctx());
    const expected = [
      '## Workspace Memory (2 memories)',
      '### Relevant to This Task\n- **[gotcha] the gotcha**: watch out',
      RECALL_LINE,
    ].join('\n');
    expect(built.memory.block).toBe(expected);
    expect(built.promptText).toContain(`${expected}\n\n## Task`);
    expect(built.promptText).not.toContain('prior lesson A');
  });

  test('a digest carrying its own headings and blank lines is still never rendered', () => {
    const built = buildPromptWithComposition(ctx({
      compactResult: { count: 2, markdown: REALISTIC_DIGEST },
    }));
    expect(built.promptText).not.toContain(REALISTIC_DIGEST);
    expect(built.memory.block).toBe([
      '## Workspace Memory (2 memories)',
      '### Relevant to This Task\n- **[gotcha] the gotcha**: watch out',
      RECALL_LINE,
    ].join('\n'));
  });

  test('no memory at all emits no block', () => {
    const built = buildPromptWithComposition(ctx({
      compactResult: { count: 0 },
      taskSearchResults: [],
      fullObservations: [],
    }));
    expect(built.memory.block).toBeNull();
    expect(built.promptText).not.toContain('## Workspace Memory');
  });

  // getCompactObservations used to prefix its markdown with its own
  // `## Workspace Memory (N memories)` line, which rendered underneath this
  // block's header. Every prompt in the fleet carried the heading twice.
  test('the header appears exactly once', () => {
    const built = buildPromptWithComposition(ctx({
      compactResult: { count: 2, markdown: REALISTIC_DIGEST },
    }));
    expect(built.promptText.match(/^## Workspace Memory/gm)).toHaveLength(1);
  });

  test('the header carries the count, and agrees with itself on plurals', () => {
    expect(buildPromptWithComposition(ctx({ compactResult: { count: 1, markdown: 'x' } })).memory.block)
      .toContain('## Workspace Memory (1 memory)');
    expect(buildPromptWithComposition(ctx({ compactResult: { count: 40, markdown: 'x' } })).memory.block)
      .toContain('## Workspace Memory (40 memories)');
  });

  test('still advertises recall/learn when nothing matched the task', () => {
    const built = buildPromptWithComposition(ctx({ taskSearchResults: [], fullObservations: [] }));
    expect(built.promptText).toContain('Use `recall');
    expect(built.promptText).toContain('Use `learn`');
    expect(built.promptText).not.toContain('### Relevant to This Task');
  });

  test('composition still reports what the digest would have cost', () => {
    const built = buildPromptWithComposition(ctx());
    expect(built.memory.digestBytes).toBe(0);
    expect(built.memory.digestBytesAvailable).toBe(Buffer.byteLength('- prior lesson A\n- prior lesson B', 'utf8'));
    expect(built.memory.taskMatchCount).toBe(1);
  });
});
