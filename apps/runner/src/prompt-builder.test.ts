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
  it('reads a stall from the phase above, not from prior run statuses', () => {
    // Stalls are the backstop sweep's job; the organizer's phase section says
    // STALLED from state alone. "Same state as prior heartbeats" was the old
    // cron-idling rule and must not come back through the protocol.
    expect(HEARTBEAT_PROTOCOL_BLOCK).not.toContain('prior heartbeats');
    expect(HEARTBEAT_PROTOCOL_BLOCK).toContain('STALLED');
  });

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

describe('buildPromptWithComposition — design source', () => {
  const url = 'https://claude.ai/artifact/exampleCanvas1';
  const withDesign = (designSource: Record<string, unknown>, claudeAiArtifacts?: 'read' | 'publish') => baseCtx({
    task: { ...baseCtx().task, context: { designSource } } as unknown as BuilddTask,
    worker: { id: 'worker-1', workspaceName: 'ws', claudeAiArtifacts } as unknown as LocalWorker,
  });
  const section = (ctx: PromptContext) => {
    const { promptText, sections } = buildPromptWithComposition(ctx);
    return { promptText, rendered: sections.find(s => s.name === 'design-source')!.rendered };
  };

  it('renders nothing without a design source', () => {
    expect(section(baseCtx()).rendered).toBe(false);
  });

  it('an opted-in worker is told to read the canvas with the Artifact tool', () => {
    const { promptText, rendered } = section(withDesign({ sourceUrl: url, artifactKeys: ['design:x/main'] }, 'read'));
    expect(rendered).toBe(true);
    expect(promptText).toContain(`Artifact list url=${url} scope=files`);
    expect(promptText).toContain('design:x/main');
  });

  it('a worker that is not opted in uses the copy-in keys and never the URL', () => {
    const { promptText } = section(withDesign({ sourceUrl: url, artifactKeys: ['design:x/main'] }));
    expect(promptText).toContain('design:x/main');
    expect(promptText).not.toContain('Artifact list');
    expect(promptText).toContain('Do not fetch claude.ai');
  });

  it('not opted in and no copy-in keys: says the design is unreachable instead of guessing', () => {
    const { promptText } = section(withDesign({ sourceUrl: url }));
    expect(promptText).toContain('no copy-in artifact keys');
  });

  const ID = '00000000-0000-4000-8000-00000000d001';
  const buildd = { artifactId: ID, revision: 2, from: 'spec', screens: ['desktop-mission'], criteria: [{ id: 'AC-8', screens: ['desktop-mission'] }] };

  it('a buildd design artifact: named with its revision, fetched with get_artifact, screens from the spec criteria', () => {
    const { promptText, rendered } = section(withDesign(buildd));
    expect(rendered).toBe(true);
    expect(promptText).toContain(`buildd artifact \`${ID}\` revision 2`);
    expect(promptText).toContain(`get_artifact artifactId=${ID} revision=2`);
    expect(promptText).toContain('file://<file>#desktop-mission');
    expect(promptText).toContain('`desktop-mission` (AC-8)');
  });

  it('both: the buildd artifact comes first, the canvas is the fallback for an opted-in worker', () => {
    const { promptText } = section(withDesign({ ...buildd, sourceUrl: url }, 'read'));
    const artifactAt = promptText.indexOf(`buildd artifact \`${ID}\``);
    const canvasAt = promptText.indexOf(`Artifact list url=${url}`);
    expect(artifactAt).toBeGreaterThan(-1);
    expect(canvasAt).toBeGreaterThan(artifactAt);
    expect(promptText).toContain('If the buildd artifact cannot be read');
  });

  it('both, worker not opted in: the buildd artifact only, never the Artifact tool', () => {
    const { promptText } = section(withDesign({ ...buildd, sourceUrl: url }));
    expect(promptText).toContain(`buildd artifact \`${ID}\``);
    expect(promptText).not.toContain('Artifact list');
    expect(promptText).not.toContain('no claude.ai artifact access and there are no copy-in');
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
      'untestable-acceptance-checks',
      'design-source',
      'work-kind',
      'handoff-requirement',
      'output-requirement',
      'optional-plan',
      'heartbeat-protocol',
      'aggregation-context',
      'retry-context',
      'answered-question',
      'unanswered-question',
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

describe('buildPromptWithComposition — refused tool calls are not a stop instruction', () => {
  // Regression: autonomous workers read a refused/cancelled tool call — whose
  // text can be Claude Code's "The user doesn't want to take this action…
  // STOP" — as the user telling them to stop, ended the session "as you
  // asked" and never called complete_task. No human is in the loop.
  for (const inputPolicy of ['autonomous', 'allow', 'important-only'] as const) {
    for (const inputAsRetry of [undefined, false] as const) {
      it(`says so under inputPolicy=${inputPolicy}, inputAsRetry=${String(inputAsRetry)}`, () => {
        const { promptText } = buildPromptWithComposition(baseCtx({ inputPolicy, inputAsRetry }));
        expect(promptText).toContain('A refused tool call is not an instruction to stop');
        expect(promptText).toContain("The user doesn't want to take this action");
        expect(promptText).toMatch(/complete_task/);
      });
    }
  }
});

describe('R-82: acceptance checks that need judgement', () => {
  it('requires a reason and a review method for every untestable check', () => {
    const ctx = baseCtx();
    ctx.task.title = '[acceptance tests] Prepare checks';
    const { promptText } = buildPromptWithComposition(ctx);
    expect(promptText).toContain('## Untestable acceptance checks');
    expect(promptText).toContain('criterion id');
    expect(promptText).toContain('why an executable test cannot check it');
    expect(promptText).toContain('code review or screenshots');
    expect(promptText).toContain('create_artifact');
    expect(promptText).toContain('complete_task');
  });

  it('keeps the instructions when the acceptance task is renamed', () => {
    const ctx = baseCtx();
    ctx.task.context = { acceptanceTests: { missionId: 'm', specId: 's' } };
    expect(buildPromptWithComposition(ctx).promptText).toContain('## Untestable acceptance checks');
  });

  it('does not ask ordinary building work to classify acceptance checks', () => {
    expect(buildPromptWithComposition(baseCtx()).promptText).not.toContain('## Untestable acceptance checks');
  });
});

// docs/specs/answered-question-resume.md AC-54: a cold answer reopens the SAME
// task for a new attempt; the answer reaches that attempt through its context.
describe('buildPromptWithComposition — answered question on a new attempt', () => {
  const withAnswers = (answeredQuestions: unknown) => baseCtx({
    task: {
      id: 'task-2',
      title: 'Build the parser',
      description: 'Parse the feed',
      outputRequirement: 'pr_required',
      roleSlug: null,
      context: { iteration: 2, resumeBranch: 'buildd/task-2-parser', answeredQuestions },
    } as unknown as BuilddTask,
  });

  it('carries every answered question and the answer verbatim, and says not to ask again', () => {
    const { promptText, sections } = buildPromptWithComposition(withAnswers([
      { id: 'e1', workerId: 'w-1', question: 'Which format?', answer: 'JSON lines, one object per row', milestones: ['Wrote the reader'], branch: 'buildd/task-2-parser', reasonCode: 'runner_not_holding_transcript', reason: 'the runner stopped reporting', answeredAt: '2026-01-01T00:00:00.000Z' },
    ]));
    expect(promptText).toContain('## Answered Question');
    expect(promptText).toContain('Which format?');
    expect(promptText).toContain('JSON lines, one object per row');
    expect(promptText).toContain('Wrote the reader');
    expect(promptText).toMatch(/do not ask it again/i);
    expect(sections.find(s => s.name === 'answered-question')!.rendered).toBe(true);
  });

  it('renders nothing without answered questions, or with a malformed list', () => {
    for (const v of [undefined, 'nope', [null, 3]]) {
      const { promptText, sections } = buildPromptWithComposition(withAnswers(v));
      expect(promptText).not.toContain('## Answered Question');
      expect(sections.find(s => s.name === 'answered-question')!.rendered).toBe(false);
    }
  });
});
