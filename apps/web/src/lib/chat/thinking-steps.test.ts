/**
 * The Thinking panel's steps, decided on the server (docs/design/chat-canvas.md,
 * "Thinking"): each tool call becomes a plain-language `data-step` (never the
 * tool's name), consecutive identical calls share one counted step, and a
 * message stored before steps existed gets them backfilled from its tool parts.
 */
import { describe, expect, it } from 'bun:test';
import { CHAT_READ_TOOLS } from '@buildd/shared';
import { backfillSteps, createStepTracker, legacyStepWeight, mergeStepParts, stepLabel, withThinkingSteps } from './thinking-steps';

describe('stepLabel', () => {
  it('rewords every read tool into a human verb, never its name', () => {
    for (const name of CHAT_READ_TOOLS) {
      for (const state of ['active', 'done'] as const) {
        const label = stepLabel(name, {}, state);
        expect(label).not.toContain('_');
        expect(label.toLowerCase()).not.toContain(name.replace(/_/g, ' '));
        expect(label).toMatch(/^[A-Z]/);
      }
    }
  });

  it('reads a multi-op tool by its action', () => {
    expect(stepLabel('manage_missions', { action: 'list' }, 'done')).toBe('Looked over the missions');
    expect(stepLabel('manage_missions', { action: 'create' }, 'active')).toBe('Drafting a mission');
  });

  it('an unknown tool still reads as plain words', () => {
    expect(stepLabel('some_new_tool', {}, 'active')).toBe('Looking something up');
    expect(stepLabel('some_new_tool', {}, 'done')).toBe('Looked something up');
    expect(stepLabel('some_new_tool', {}, 'failed')).toBe("Couldn't look it up");
  });

  it('counts a run of the same call', () => {
    expect(stepLabel('get_task', {}, 'done', 3)).toBe('Read 3 tasks');
    expect(stepLabel('get_task', {}, 'done', 1)).toBe('Read a task');
  });
});

describe('createStepTracker', () => {
  it('two different calls: each is active, then done, under its call id', () => {
    const t = createStepTracker();
    const seq = [
      ...t.start('c1', 'manage_missions', { action: 'list' }),
      ...t.output('c1'),
      ...t.start('c2', 'recall', { query: 'x' }),
      ...t.output('c2'),
    ];
    expect(seq).toEqual([
      { id: 'c1', label: 'Looking over the missions', state: 'active', weight: 'routine' },
      { id: 'c1', label: 'Looked over the missions', state: 'done', weight: 'routine' },
      { id: 'c2', label: 'Searching what buildd remembers', state: 'active', weight: 'routine' },
      { id: 'c2', label: 'Searched what buildd remembers', state: 'done', weight: 'routine' },
    ]);
  });

  it('consecutive identical calls share one counted step', () => {
    const t = createStepTracker();
    t.start('c1', 'get_task', {});
    t.start('c2', 'get_task', {});
    expect(t.output('c1')).toEqual([{ id: 'c1', label: 'Reading 2 tasks', state: 'active', weight: 'routine' }]);
    expect(t.output('c2')).toEqual([{ id: 'c1', label: 'Read 2 tasks', state: 'done', weight: 'routine' }]);
    expect(t.steps()).toHaveLength(1);
  });

  it('a failed call says so in plain words; in a run it gets its own step', () => {
    const lone = createStepTracker();
    lone.start('c1', 'get_pr', {});
    expect(lone.error('c1')).toEqual([{ id: 'c1', label: "Couldn't check the change", state: 'done', weight: 'key' }]);

    const run = createStepTracker();
    run.start('c1', 'get_task', {});
    run.start('c2', 'get_task', {});
    run.output('c1');
    expect(run.error('c2')).toEqual([
      { id: 'c1', label: 'Read a task', state: 'done', weight: 'routine' },
      { id: 'failed-c2', label: "Couldn't open the task", state: 'done', weight: 'key' },
    ]);
  });

  it('a change waiting on the person is the pending step, then done once it runs', () => {
    const t = createStepTracker();
    t.start('c1', 'list_tasks', {});
    t.output('c1');
    t.start('c2', 'manage_missions', { action: 'create' });
    expect(t.approval('c2')).toEqual([{ id: 'c2', label: 'Check it with you', state: 'pending', weight: 'key' }]);
    expect(t.output('c2')).toEqual([{ id: 'c2', label: 'Drafted a mission', state: 'done', weight: 'routine' }]);
  });

  it('a denied change reads as not done', () => {
    const t = createStepTracker();
    t.start('c1', 'manage_missions', { action: 'create' });
    t.approval('c1');
    expect(t.denied('c1')).toEqual([{ id: 'c1', label: 'Not done', state: 'done', weight: 'key' }]);
  });

  it('an output for a call it never saw start: labelled from the call the continuation carries', () => {
    const t = createStepTracker({ known: [{ toolCallId: 'c9', toolName: 'manage_missions', input: { action: 'create' } }] });
    expect(t.output('c9')).toEqual([{ id: 'c9', label: 'Drafted a mission', state: 'done', weight: 'routine' }]);
    expect(t.output('nobody')).toEqual([]);
  });
});

describe('step weight (key or routine, decided here)', () => {
  const task = { data: {}, objects: [{ kind: 'task', id: 't1', fallbackText: 'Task' }] };

  it('a read is routine, even when it returns objects', () => {
    const t = createStepTracker();
    expect(t.start('c1', 'get_task', {})[0].weight).toBe('routine');
    expect(t.output('c1', task)[0].weight).toBe('routine');
  });

  it('a counted read run is routine', () => {
    const t = createStepTracker();
    t.start('c1', 'get_task', {});
    t.start('c2', 'get_task', {});
    t.output('c1', task);
    expect(t.output('c2', task)).toEqual([{ id: 'c1', label: 'Read 2 tasks', state: 'done', weight: 'routine' }]);
  });

  it('a failure is key', () => {
    const t = createStepTracker();
    t.start('c1', 'list_tasks', {});
    expect(t.error('c1')[0]).toMatchObject({ label: "Couldn't list the tasks", weight: 'key' });
  });

  it('a change waiting on the person is key, and so is a refusal', () => {
    const t = createStepTracker();
    t.start('c1', 'create_task', { title: 'A' });
    expect(t.approval('c1')[0]).toMatchObject({ state: 'pending', weight: 'key' });
    expect(t.denied('c1')[0]).toMatchObject({ label: 'Not done', weight: 'key' });
  });

  it('a write that returned an object is key; one that returned nothing is routine', () => {
    const t = createStepTracker();
    t.start('c1', 'create_task', { title: 'A' });
    t.approval('c1');
    expect(t.output('c1', task)).toEqual([{ id: 'c1', label: 'Drafted a task', state: 'done', weight: 'key' }]);
    t.start('c2', 'send_agent_message', { taskId: 't1', message: 'hi' });
    expect(t.output('c2', { data: {}, objects: [] })[0].weight).toBe('routine');
  });

  it('the stream carries the output through to the weight', async () => {
    const tracker = createStepTracker();
    const src = new ReadableStream({ start(c) {
      c.enqueue({ type: 'tool-input-available', toolCallId: 'c1', toolName: 'create_task', input: { title: 'A' } });
      c.enqueue({ type: 'tool-output-available', toolCallId: 'c1', output: task });
      c.close();
    } });
    const reader = withThinkingSteps(src, { tracker }).getReader();
    const out: any[] = [];
    for (;;) { const { done, value } = await reader.read(); if (done) break; out.push(value); }
    expect(out.filter(c => c.type === 'data-step').map(c => c.data.weight)).toEqual(['routine', 'key']);
  });

  it('a stored step without a weight: failures, refusals and waiting changes are key', () => {
    expect(legacyStepWeight({ id: 'a', label: "Couldn't open the task", state: 'done' })).toBe('key');
    expect(legacyStepWeight({ id: 'a', label: 'Not done', state: 'done' })).toBe('key');
    expect(legacyStepWeight({ id: 'a', label: 'Check it with you', state: 'pending' })).toBe('key');
    expect(legacyStepWeight({ id: 'a', label: 'Read a task', state: 'done' })).toBe('routine');
    expect(legacyStepWeight({ id: 'a', label: 'Drafted a task', state: 'done' })).toBe('routine');
    expect(legacyStepWeight({ id: 'a', label: 'Read a task', state: 'done', weight: 'key' })).toBe('key');
  });
});

const call = (id: string, name: string, state: string, input: Record<string, unknown> = {}, over: Record<string, unknown> = {}) =>
  ({ type: `tool-${name}`, toolCallId: id, state, input, ...over });

describe('backfillSteps (a message stored before steps existed)', () => {
  it('derives the same steps from the stored tool parts', () => {
    const steps = backfillSteps([
      { type: 'step-start' },
      call('c1', 'get_task', 'output-available'),
      call('c2', 'get_task', 'output-available'),
      call('c3', 'get_pr', 'output-error', {}, { errorText: 'boom' }),
      call('c4', 'create_task', 'output-denied', {}, { approval: { id: 'a0', approved: false } }),
      call('c5', 'manage_missions', 'approval-responded', { action: 'create' }, { approval: { id: 'a1', approved: true } }),
    ]);
    expect(steps).toEqual([
      { id: 'c1', label: 'Read 2 tasks', state: 'done', weight: 'routine' },
      { id: 'c3', label: "Couldn't check the change", state: 'done', weight: 'key' },
      { id: 'c4', label: 'Not done', state: 'done', weight: 'key' },
      { id: 'c5', label: 'Check it with you', state: 'pending', weight: 'key' },
    ]);
  });

  it('a message that already has steps is left alone', () => {
    expect(backfillSteps([call('c1', 'get_task', 'output-available'), { type: 'data-step', id: 'c1', data: { id: 'c1', label: 'Read a task', state: 'done' } }])).toEqual([]);
  });

  it('no tool calls, no steps', () => {
    expect(backfillSteps([{ type: 'text', text: 'hi' }])).toEqual([]);
  });
});

describe('mergeStepParts', () => {
  it('each step lands after its call; a newer state replaces the stored one in place', () => {
    const parts = [
      call('c1', 'get_task', 'output-available'),
      { type: 'data-step', id: 'c1', data: { id: 'c1', label: 'Check it with you', state: 'pending' } },
      call('c2', 'recall', 'output-available'),
      { type: 'text', text: 'ok' },
    ];
    const out = mergeStepParts(parts, [
      { id: 'c1', label: 'Read a task', state: 'done' },
      { id: 'c2', label: 'Searched what buildd remembers', state: 'done' },
      { id: 'failed-c3', label: "Couldn't open the task", state: 'done' },
    ]);
    expect(out.map(p => (p.type === 'data-step' ? `step:${(p as any).data.label}` : p.type))).toEqual([
      'tool-get_task', 'step:Read a task', 'tool-recall', 'step:Searched what buildd remembers', 'text', "step:Couldn't open the task",
    ]);
  });
});

describe('withThinkingSteps', () => {
  async function run(chunks: any[], opts: Parameters<typeof withThinkingSteps>[1] = {}) {
    const tracker = createStepTracker();
    const src = new ReadableStream({ start(c) { for (const x of chunks) c.enqueue(x); c.close(); } });
    const out: any[] = [];
    const reader = withThinkingSteps(src, { tracker, ...opts }).getReader();
    for (;;) { const { done, value } = await reader.read(); if (done) break; out.push(value); }
    return out;
  }

  it('follows each tool chunk with its step, and backfills an old message right after start', async () => {
    const out = await run([
      { type: 'start' },
      { type: 'tool-input-available', toolCallId: 'c1', toolName: 'list_tasks', input: {} },
      { type: 'tool-output-available', toolCallId: 'c1', output: {} },
      { type: 'finish' },
    ], { backfill: [{ id: 'old', label: 'Read a task', state: 'done' }] });
    expect(out.map(c => (c.type === 'data-step' ? `${c.id}:${c.data.state}` : c.type))).toEqual([
      'start', 'old:done', 'tool-input-available', 'c1:active', 'tool-output-available', 'c1:done', 'finish',
    ]);
  });
});
