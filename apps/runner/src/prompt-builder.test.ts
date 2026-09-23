import { describe, it, expect } from 'bun:test';
import { HEARTBEAT_PROTOCOL_BLOCK } from '@buildd/shared';
import { buildPromptWithComposition, type PromptContext } from './prompt-builder';
import type { BuilddTask, LocalWorker } from './types';

function baseCtx(overrides: Partial<PromptContext> = {}): PromptContext {
  return {
    task: {
      id: 'task-1',
      title: 'Some task',
      description: 'Do the thing',
      outputRequirement: 'none',
      roleSlug: null,
      context: {},
    } as unknown as BuilddTask,
    worker: {
      id: 'worker-1',
      workspaceName: 'ws',
    } as unknown as LocalWorker,
    isConfigured: false,
    compactResult: { count: 0 },
    taskSearchResults: [],
    fullObservations: [],
    inputPolicy: 'autonomous',
    hasApiKey: true,
    ...overrides,
  };
}

describe('buildPromptWithComposition — heartbeat protocol injection', () => {
  it('injects HEARTBEAT_PROTOCOL_BLOCK exactly once for a heartbeat task', () => {
    const ctx = baseCtx({
      task: {
        id: 'hb-1',
        title: 'Heartbeat',
        description: '## Heartbeat: Some mission\n## Checklist\n- do things',
        outputRequirement: 'none',
        roleSlug: 'organizer',
        context: { heartbeat: true },
      } as unknown as BuilddTask,
    });

    const { promptText } = buildPromptWithComposition(ctx);
    const occurrences = promptText.split('You are running a mission heartbeat').length - 1;
    expect(occurrences).toBe(1);
    expect(promptText).toContain(HEARTBEAT_PROTOCOL_BLOCK);
    expect(promptText).toContain('Prior-work gate');
    expect(promptText).toContain('## Direct Action');
  });

  it('injects the protocol regardless of roleSlug — a heartbeat can be dispatched under a non-organizer role', () => {
    // mission-run.ts's dominant-role derivation can set a heartbeat task's
    // roleSlug to the mission's dominant child role (e.g. 'builder') instead
    // of 'organizer', so the injection must not key off roleSlug at all.
    const ctx = baseCtx({
      task: {
        id: 'hb-2',
        title: 'Heartbeat',
        description: 'heartbeat body',
        outputRequirement: 'none',
        roleSlug: 'builder',
        context: { heartbeat: true },
      } as unknown as BuilddTask,
    });

    const { promptText } = buildPromptWithComposition(ctx);
    expect(promptText).toContain('You are running a mission heartbeat');
  });

  it('injects the protocol when the task carries no roleSlug at all', () => {
    const ctx = baseCtx({
      task: {
        id: 'hb-3',
        title: 'Heartbeat',
        description: 'heartbeat body',
        outputRequirement: 'none',
        roleSlug: null,
        context: { heartbeat: true },
      } as unknown as BuilddTask,
    });

    const { promptText } = buildPromptWithComposition(ctx);
    expect(promptText).toContain('You are running a mission heartbeat');
  });

  it('does not inject the protocol for a non-heartbeat task', () => {
    const ctx = baseCtx({
      task: {
        id: 'plain-1',
        title: 'Ordinary build task',
        description: 'Fix the bug',
        outputRequirement: 'pr_required',
        roleSlug: 'builder',
        context: {},
      } as unknown as BuilddTask,
    });

    const { promptText } = buildPromptWithComposition(ctx);
    expect(promptText).not.toContain('You are running a mission heartbeat');
    expect(promptText).not.toContain('## Direct Action');
  });

  it('does not inject the protocol when context is undefined', () => {
    const ctx = baseCtx({
      task: {
        id: 'plain-2',
        title: 'Ordinary build task',
        description: 'Fix the bug',
        outputRequirement: 'pr_required',
        roleSlug: 'builder',
        context: undefined,
      } as unknown as BuilddTask,
    });

    const { promptText } = buildPromptWithComposition(ctx);
    expect(promptText).not.toContain('You are running a mission heartbeat');
  });
});

describe('buildPromptWithComposition — task description truncation', () => {
  // Defect 2 regression: a bare `\n---` used to be treated as a terminator
  // for ANY content after it, even though a markdown thematic break is
  // ordinary prose. Proves the fix: real spec content containing a horizontal
  // rule survives intact in the rendered prompt.
  it('keeps a markdown horizontal rule in the task description intact', () => {
    const description = [
      '## Design',
      'Some real content before the rule.',
      '',
      '---',
      '',
      '## More design',
      'Content after the rule that the old `indexOf(\'\\n---\')` check discarded.',
    ].join('\n');
    const ctx = baseCtx({
      task: {
        id: 'desc-1',
        title: 'Spec task',
        description,
        outputRequirement: 'none',
        roleSlug: null,
        context: {},
      } as unknown as BuilddTask,
    });

    const { promptText, sections } = buildPromptWithComposition(ctx);
    expect(promptText).toContain('## More design');
    expect(promptText).toContain('Content after the rule that the old');
    const descSection = sections.find(s => s.name === 'task-description')!;
    expect(descSection.truncated).toBe(false);
    expect(descSection.rendered).toBe(true);
  });

  // The original intent of the strip: a description polluted by an echoed
  // prompt footer (the exact `---\nTask ID: ...` shape this function appends
  // at the very end) must still be cleaned up.
  it('still strips an echoed prompt-footer signature from a polluted description', () => {
    const description = 'Real spec content.\n---\nTask ID: abc-123\nWorker ID: def-456\nWorkspace: some-ws';
    const ctx = baseCtx({
      task: {
        id: 'desc-2',
        title: 'Polluted task',
        description,
        outputRequirement: 'none',
        roleSlug: null,
        context: {},
      } as unknown as BuilddTask,
    });

    const { promptText, sections } = buildPromptWithComposition(ctx);
    expect(promptText).toContain('Real spec content.');
    expect(promptText).not.toContain('Worker ID: def-456');
    const descSection = sections.find(s => s.name === 'task-description')!;
    expect(descSection.truncated).toBe(true);
  });
});

describe('buildPromptWithComposition — per-section byte accounting', () => {
  it('reports every known section, rendered or not', () => {
    const ctx = baseCtx();
    const { sections } = buildPromptWithComposition(ctx);
    const names = sections.map(s => s.name);
    expect(names).toEqual([
      'workspace-instructions',
      'git-workflow',
      'workspace-memory',
      'user-preferences',
      'resolved-context-providers',
      'task-description',
      'work-kind',
      'handoff-requirement',
      'output-requirement',
      'optional-plan',
      'heartbeat-protocol',
      'aggregation-context',
      'retry-context',
      'communication',
      'task-metadata',
    ]);
    // baseCtx is unconfigured, has no feedback/context providers/heartbeat —
    // those sections must report rendered:false rather than being absent.
    for (const n of ['workspace-instructions', 'git-workflow', 'user-preferences', 'resolved-context-providers', 'heartbeat-protocol']) {
      const s = sections.find(x => x.name === n)!;
      expect(s.rendered).toBe(false);
      expect(s.bytes).toBe(0);
    }
    // Always-on sections must report real bytes.
    for (const n of ['task-description', 'output-requirement', 'communication', 'task-metadata']) {
      const s = sections.find(x => x.name === n)!;
      expect(s.rendered).toBe(true);
      expect(s.bytes).toBeGreaterThan(0);
    }
  });

  it('reports byte sizes that match the actual rendered content', () => {
    const ctx = baseCtx({
      task: {
        id: 'bytes-1',
        title: 'Task',
        description: 'A description with some length to it.',
        outputRequirement: 'pr_required',
        roleSlug: null,
        context: {},
      } as unknown as BuilddTask,
    });
    const { sections } = buildPromptWithComposition(ctx);
    const desc = sections.find(s => s.name === 'task-description')!;
    expect(desc.bytes).toBe(Buffer.byteLength('## Task\nA description with some length to it.', 'utf8'));
  });

  // Regression for a duplicate-push bug: a leftover for-loop pushed each
  // resolvedContextProviders block into promptParts directly, and addSection
  // pushed the joined content again — every task with context providers got
  // that content duplicated verbatim in the actual prompt.
  it('renders resolved context providers exactly once', () => {
    const block = 'Some resolved context block.';
    const ctx = baseCtx({ resolvedContextProviders: [block] });
    const { promptText, sections } = buildPromptWithComposition(ctx);

    const occurrences = promptText.split(block).length - 1;
    expect(occurrences).toBe(1);

    const section = sections.find(s => s.name === 'resolved-context-providers')!;
    expect(section.rendered).toBe(true);
    expect(section.bytes).toBe(Buffer.byteLength(block, 'utf8'));
  });
});
