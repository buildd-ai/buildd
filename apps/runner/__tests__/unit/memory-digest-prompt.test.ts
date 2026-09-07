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

/**
 * A digest shaped like the real one. `getCompactObservations` renders
 * `## Workspace Memory (N memories)` as the digest's own first line and then
 * `### <Type>s` subsections — so the assembled block contains a SECOND
 * `## Workspace Memory` heading, and memory bodies are user-authored markdown
 * that can contain blank lines and headings of their own.
 *
 * An earlier version of this file located the block by scanning for the next
 * `\n\n## `, which this fixture breaks. Tests now read the block the production
 * code actually returns, so there is nothing left to mis-parse.
 */
const REALISTIC_DIGEST = [
  '## Workspace Memory (2 memories)',
  '',
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

describe('workspace memory block — control arm is unchanged', () => {
  test('default config renders the legacy block verbatim', () => {
    const built = buildPromptWithComposition(ctx());
    const expected = [
      '## Workspace Memory',
      '- prior lesson A\n- prior lesson B',
      '### Relevant to This Task\n- **[gotcha] the gotcha**: watch out',
      LEGACY_RECALL_LINE,
    ].join('\n');
    expect(built.memory.block).toBe(expected);
    // And it really is in the prompt, delimited the way promptParts joins.
    // (This fixture has no workspace instructions or git config, so the memory
    // block is the first part — hence no leading separator to assert.)
    expect(built.promptText).toContain(`${expected}\n\n## Task`);
  });

  test('the block survives a digest carrying its own headings and blank lines', () => {
    const built = buildPromptWithComposition(ctx({
      compactResult: { count: 2, markdown: REALISTIC_DIGEST },
    }));
    expect(built.memory.block).toBe([
      '## Workspace Memory',
      REALISTIC_DIGEST,
      '### Relevant to This Task\n- **[gotcha] the gotcha**: watch out',
      LEGACY_RECALL_LINE,
    ].join('\n'));
    expect(built.promptText).toContain(REALISTIC_DIGEST);
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
    const built = buildPromptWithComposition(ctx({
      compactResult: { count: 0 },
      taskSearchResults: [],
      fullObservations: [],
    }));
    expect(built.memory.block).toBeNull();
    expect(built.promptText).not.toContain('## Workspace Memory');
  });

  test('the buildPrompt wrapper returns the same text as the full result', () => {
    expect(buildPrompt(ctx())).toBe(buildPromptWithComposition(ctx()).promptText);
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
    const control = buildPromptWithComposition(ctx());
    const treated = buildPromptWithComposition(ctx({ memoryDigestTaskScopedFraction: 1 }));
    // Strip using the blocks the code itself reports, not a heading scan.
    const strip = (p: string, block: string | null) => (block ? p.replace(block, '') : p);
    expect(strip(treated.promptText, treated.memory.block))
      .toBe(strip(control.promptText, control.memory.block));
  });

  test('the arm shortens the prompt by exactly the digest and its separator', () => {
    const control = buildPromptWithComposition(ctx());
    const treated = buildPromptWithComposition(ctx({ memoryDigestTaskScopedFraction: 1 }));
    const saved = Buffer.byteLength(control.promptText, 'utf8')
      - Buffer.byteLength(treated.promptText, 'utf8');
    // The digest plus the single '\n' that joined it into the block. Asserted
    // against the reported counterfactual, so a digestBytesAvailable computed
    // from the wrong string (e.g. before the truncation note) fails here.
    expect(saved).toBe(control.memory.digestBytesAvailable + 1);
    expect(control.memory.digestBytesAvailable).toBeGreaterThan(0);
  });

  // Guards the fixture assumption the previous version of the test above
  // silently relied on: with no digest there is nothing to save, and the
  // "+1 separator" reasoning does not apply.
  test('an empty digest saves nothing, in either arm', () => {
    const args = { compactResult: { count: 2, markdown: '' } };
    const control = buildPromptWithComposition(ctx(args));
    const treated = buildPromptWithComposition(ctx({ ...args, memoryDigestTaskScopedFraction: 1 }));
    expect(control.memory.digestBytesAvailable).toBe(0);
    expect(control.promptText).toBe(treated.promptText);
  });

  test('composition is reported for the control too, not only the treatment', () => {
    const control = buildPromptWithComposition(ctx());
    expect(control.memory.digestBytes).toBe(Buffer.byteLength('- prior lesson A\n- prior lesson B', 'utf8'));
    expect(control.memory.taskMatchCount).toBe(1);
  });
});
