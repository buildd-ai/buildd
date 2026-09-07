import { describe, expect, test } from 'bun:test';
import { buildPrompt, buildPromptWithComposition } from '../../src/prompt-builder';

/**
 * The control arm must be byte-identical to the behaviour that shipped before
 * memory-digest-policy.ts existed. These tests pin the rendered
 * `## Workspace Memory` section against a literal copy of the legacy output,
 * so a refactor of the block builder cannot quietly move the baseline the
 * experiment is measured against.
 */

const LEGACY_RECALL_LINE =
  '\nUse `recall scope=["memory","task"]` for full context (prior lessons + recent outcomes in one call). Use `learn` to record gotchas/patterns/decisions — NOT summaries.';

function ctx(overrides: Record<string, unknown> = {}) {
  return {
    task: { id: 'task-4711', title: 'Do the thing', description: 'Do the thing properly' },
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

/** Pull the `## Workspace Memory` block out of an assembled prompt. */
function memorySection(prompt: string): string {
  const start = prompt.indexOf('## Workspace Memory');
  if (start < 0) return '';
  const end = prompt.indexOf('\n\n## ', start);
  return end < 0 ? prompt.slice(start) : prompt.slice(start, end);
}

describe('workspace memory block — control arm is unchanged', () => {
  test('default config renders the legacy block verbatim', () => {
    const prompt = buildPrompt(ctx());
    const expected = [
      '## Workspace Memory',
      '- prior lesson A\n- prior lesson B',
      '### Relevant to This Task\n- **[gotcha] the gotcha**: watch out',
      LEGACY_RECALL_LINE,
    ].join('\n');
    expect(memorySection(prompt)).toBe(expected);
  });

  test('an absent fraction is the control, not an unset experiment', () => {
    const built = buildPromptWithComposition(ctx());
    expect(built.assignment.arm).toBe('full');
    expect(built.assignment.fraction).toBe(0);
    expect(built.promptText).toContain('- prior lesson A');
  });

  test('an out-of-range fraction still renders the control', () => {
    const built = buildPromptWithComposition(ctx({ memoryDigestTaskScopedFraction: 42 }));
    expect(built.assignment.arm).toBe('full');
    expect(built.promptText).toContain('- prior lesson A');
  });

  test('no memory at all still emits no block, as before', () => {
    const prompt = buildPrompt(ctx({
      compactResult: { count: 0 },
      taskSearchResults: [],
      fullObservations: [],
    }));
    expect(prompt).not.toContain('## Workspace Memory');
  });
});

describe('workspace memory block — task_scoped arm', () => {
  test('fully enrolled prompts lose the digest and keep the task matches', () => {
    const built = buildPromptWithComposition(ctx({ memoryDigestTaskScopedFraction: 1 }));
    expect(built.assignment.arm).toBe('task_scoped');
    expect(built.promptText).not.toContain('- prior lesson A');
    expect(built.promptText).toContain('### Relevant to This Task');
    expect(built.promptText).toContain('- **[gotcha] the gotcha**: watch out');
  });

  test('everything outside the memory block is untouched', () => {
    const control = buildPromptWithComposition(ctx()).promptText;
    const treated = buildPromptWithComposition(ctx({ memoryDigestTaskScopedFraction: 1 })).promptText;
    const strip = (s: string) => s.replace(memorySection(s), '');
    expect(strip(treated)).toBe(strip(control));
  });

  test('the arm shortens the prompt by exactly the digest', () => {
    const control = buildPromptWithComposition(ctx());
    const treated = buildPromptWithComposition(ctx({ memoryDigestTaskScopedFraction: 1 }));
    const saved = Buffer.byteLength(control.promptText, 'utf8')
      - Buffer.byteLength(treated.promptText, 'utf8');
    // One extra byte for the newline that joined the digest into the block.
    expect(saved).toBe(control.memory.digestBytesAvailable + 1);
  });

  test('composition is reported for the control too, not only the treatment', () => {
    const control = buildPromptWithComposition(ctx());
    expect(control.memory.digestBytes).toBeGreaterThan(0);
    expect(control.memory.digestBytesAvailable).toBe(control.memory.digestBytes);
    expect(control.memory.taskMatchCount).toBe(1);
  });
});
