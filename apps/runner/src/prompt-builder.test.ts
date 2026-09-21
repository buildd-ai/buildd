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
