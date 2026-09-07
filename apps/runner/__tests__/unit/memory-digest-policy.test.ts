import { describe, expect, test } from 'bun:test';
import {
  FULL_DIGEST_MAX_BYTES,
  MEMORY_DIGEST_POLICY_VERSION,
  appendPromptCompositionEvent,
  assignMemoryDigestArm,
  buildMemoryBlock,
  buildPromptCompositionRecord,
  resolveTaskScopedFraction,
} from '../../src/memory-digest-policy';

const obs = (n: number) => Array.from({ length: n }, (_, i) => ({
  type: 'gotcha',
  title: `lesson ${i}`,
  content: `content ${i}`,
}));

describe('resolveTaskScopedFraction', () => {
  test('honours a fraction already inside range', () => {
    expect(resolveTaskScopedFraction(0.25)).toBe(0.25);
    expect(resolveTaskScopedFraction(0)).toBe(0);
    expect(resolveTaskScopedFraction(1)).toBe(1);
  });

  test('accepts a numeric string, because the operator knob is an env var', () => {
    expect(resolveTaskScopedFraction('0.5')).toBe(0.5);
    expect(resolveTaskScopedFraction(' 0.1 ')).toBe(0.1);
  });

  // The failure this guards is specific: someone types 15 meaning 15%. Clamping
  // would enrol the whole fleet in the treatment; rejecting runs the control.
  test('rejects an out-of-range value instead of clamping it', () => {
    expect(resolveTaskScopedFraction(15)).toBe(0);
    expect(resolveTaskScopedFraction('15')).toBe(0);
    expect(resolveTaskScopedFraction(1.0001)).toBe(0);
    expect(resolveTaskScopedFraction(-0.5)).toBe(0);
  });

  test('rejects junk', () => {
    expect(resolveTaskScopedFraction(undefined)).toBe(0);
    expect(resolveTaskScopedFraction(null)).toBe(0);
    expect(resolveTaskScopedFraction('')).toBe(0);
    expect(resolveTaskScopedFraction('half')).toBe(0);
    expect(resolveTaskScopedFraction(NaN)).toBe(0);
    expect(resolveTaskScopedFraction(Infinity)).toBe(0);
    expect(resolveTaskScopedFraction({})).toBe(0);
  });
});

describe('assignMemoryDigestArm', () => {
  test('fraction 0 puts everyone in the control at propensity 1', () => {
    for (const id of ['a', 'b', 'c', 'task-4711']) {
      const a = assignMemoryDigestArm(id, 0);
      expect(a.arm).toBe('full');
      expect(a.propensity).toBe(1);
    }
  });

  test('fraction 1 puts everyone in the treatment at propensity 1', () => {
    const a = assignMemoryDigestArm('task-4711', 1);
    expect(a.arm).toBe('task_scoped');
    expect(a.propensity).toBe(1);
  });

  test('a bad fraction falls back to the control, not to a coin flip', () => {
    expect(assignMemoryDigestArm('task-4711', '15').arm).toBe('full');
    expect(assignMemoryDigestArm('task-4711', undefined).arm).toBe('full');
  });

  test('assignment is stable for the same task id', () => {
    const first = assignMemoryDigestArm('task-4711', 0.5);
    for (let i = 0; i < 20; i++) {
      expect(assignMemoryDigestArm('task-4711', 0.5).arm).toBe(first.arm);
    }
  });

  // Randomising per worker would split a retried task's outcome across both
  // arms — the rework columns this is judged on span attempts.
  test('the randomisation unit is the task, so retries stay in one arm', () => {
    const a = assignMemoryDigestArm('task-4711', 0.5);
    const b = assignMemoryDigestArm('task-4711', 0.5);
    expect(b.arm).toBe(a.arm);
    expect(b.propensity).toBe(a.propensity);
  });

  test('an absent task id runs the control rather than an unstable draw', () => {
    expect(assignMemoryDigestArm(undefined, 1).arm).toBe('full');
    expect(assignMemoryDigestArm('', 1).arm).toBe('full');
  });

  test('propensity is the probability of the arm actually drawn', () => {
    const ids = Array.from({ length: 400 }, (_, i) => `task-${i}`);
    for (const id of ids) {
      const a = assignMemoryDigestArm(id, 0.3);
      expect(a.propensity).toBeCloseTo(a.arm === 'task_scoped' ? 0.3 : 0.7, 10);
    }
  });

  test('the hash spreads task ids roughly evenly', () => {
    const ids = Array.from({ length: 2000 }, (_, i) => `task-${i}-${i * 7}`);
    const treated = ids.filter(id => assignMemoryDigestArm(id, 0.5).arm === 'task_scoped').length;
    // A uniform hash puts this near 1000; the band is wide enough not to be
    // flaky but narrow enough to catch a hash that buckets everything one way.
    expect(treated).toBeGreaterThan(850);
    expect(treated).toBeLessThan(1150);
  });

  test('every assignment carries the policy version', () => {
    expect(assignMemoryDigestArm('task-4711', 0.5).policyVersion).toBe(MEMORY_DIGEST_POLICY_VERSION);
  });
});

describe('buildMemoryBlock — control arm', () => {
  test('renders digest, task matches and the recall pointer, in that order', () => {
    const r = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 3, markdown: 'DIGEST BODY' },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    });
    const block = r.block!;
    expect(block.indexOf('## Workspace Memory')).toBe(0);
    expect(block.indexOf('DIGEST BODY')).toBeGreaterThan(0);
    expect(block.indexOf('### Relevant to This Task')).toBeGreaterThan(block.indexOf('DIGEST BODY'));
    expect(block.indexOf('Use `recall')).toBeGreaterThan(block.indexOf('### Relevant to This Task'));
  });

  // The blind slice is preserved deliberately: fixing it to fall on a line
  // boundary is an improvement, but doing it here would move the control while
  // the experiment is running.
  test('slices an oversized digest at the byte cap and says so', () => {
    const r = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 9, markdown: 'x'.repeat(FULL_DIGEST_MAX_BYTES + 500) },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.digestTruncated).toBe(true);
    expect(r.block).toContain('*(truncated — use `recall` for more)*');
    expect(r.block).toContain('x'.repeat(FULL_DIGEST_MAX_BYTES));
    expect(r.block).not.toContain('x'.repeat(FULL_DIGEST_MAX_BYTES + 1));
  });

  test('truncates each task match at the per-observation cap', () => {
    const r = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 1, markdown: '' },
      taskSearchResults: [{ id: '1' }],
      fullObservations: [{ type: 'gotcha', title: 't', content: 'y'.repeat(500) }],
    });
    expect(r.block).toContain('y'.repeat(300) + '...');
    expect(r.block).not.toContain('y'.repeat(301));
  });

  test('renders nothing when the workspace has no memory and nothing matched', () => {
    const r = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 0 },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.block).toBeNull();
    expect(r.digestBytes).toBe(0);
  });
});

describe('buildMemoryBlock — task_scoped arm', () => {
  test('drops the workspace-wide digest', () => {
    const r = buildMemoryBlock({
      arm: 'task_scoped',
      compactResult: { count: 3, markdown: 'DIGEST BODY' },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    });
    expect(r.block).not.toContain('DIGEST BODY');
    expect(r.digestBytes).toBe(0);
  });

  test('keeps the task-specific matches untouched', () => {
    const control = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 3, markdown: 'DIGEST' },
      taskSearchResults: [{ id: '1' }, { id: '2' }],
      fullObservations: obs(2),
    });
    const treated = buildMemoryBlock({
      arm: 'task_scoped',
      compactResult: { count: 3, markdown: 'DIGEST' },
      taskSearchResults: [{ id: '1' }, { id: '2' }],
      fullObservations: obs(2),
    });
    expect(treated.taskMatchBytes).toBe(control.taskMatchBytes);
    expect(treated.taskMatchCount).toBe(control.taskMatchCount);
    expect(treated.block).toContain('- **[gotcha] lesson 0**: content 0');
    expect(treated.block).toContain('- **[gotcha] lesson 1**: content 1');
  });

  // The pointer is behavioural instruction, not context. Dropping it would
  // change how often agents call `learn` and confound the size effect.
  test('still advertises recall/learn when nothing matched the task', () => {
    const r = buildMemoryBlock({
      arm: 'task_scoped',
      compactResult: { count: 12, markdown: 'DIGEST BODY' },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.block).toContain('Use `recall');
    expect(r.block).toContain('Use `learn`');
    expect(r.block).not.toContain('DIGEST BODY');
    expect(r.block).not.toContain('### Relevant to This Task');
  });

  test('renders nothing when there is no memory at all, same as the control', () => {
    const r = buildMemoryBlock({
      arm: 'task_scoped',
      compactResult: { count: 0 },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.block).toBeNull();
  });

  // Without this, a control row cannot tell you what the treatment would have
  // saved, and exposure gets entangled with effect.
  test('reports the counterfactual digest size in both arms', () => {
    const args = {
      compactResult: { count: 3, markdown: 'DIGEST BODY' },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    };
    const control = buildMemoryBlock({ arm: 'full', ...args });
    const treated = buildMemoryBlock({ arm: 'task_scoped', ...args });
    expect(treated.digestBytesAvailable).toBe(control.digestBytesAvailable);
    expect(treated.digestBytesAvailable).toBeGreaterThan(0);
    expect(control.digestBytes).toBe(control.digestBytesAvailable);
    expect(treated.digestBytes).toBe(0);
  });

  test('the two arms differ on exactly one axis', () => {
    const args = {
      compactResult: { count: 3, markdown: 'DIGEST BODY\nsecond line' },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    };
    const control = buildMemoryBlock({ arm: 'full', ...args })!.block!;
    const treated = buildMemoryBlock({ arm: 'task_scoped', ...args })!.block!;
    // Removing the digest lines from the control yields the treatment exactly.
    expect(control.replace('\nDIGEST BODY\nsecond line', '')).toBe(treated);
  });
});

describe('buildPromptCompositionRecord', () => {
  test('measures the memory block as a share of the whole prompt', () => {
    const memory = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 3, markdown: 'D'.repeat(100) },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    });
    const promptText = 'P'.repeat(1000) + memory.block;
    const rec = buildPromptCompositionRecord({
      assignment: assignMemoryDigestArm('task-4711', 0),
      memory,
      promptText,
    });
    expect(rec.promptBytes).toBe(Buffer.byteLength(promptText, 'utf8'));
    expect(rec.memoryBlockBytes).toBe(Buffer.byteLength(memory.block!, 'utf8'));
    expect(rec.memoryShare).toBeCloseTo(rec.memoryBlockBytes / rec.promptBytes, 3);
  });

  test('counts bytes, not code units, so non-ASCII memory is not understated', () => {
    const memory = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 1, markdown: '→'.repeat(50) },
      taskSearchResults: [],
      fullObservations: [],
    });
    // U+2192 is three bytes in UTF-8; a length-based count would report 50.
    expect(memory.digestBytes).toBeGreaterThanOrEqual(150);
  });

  test('a control row carries the arm, propensity and policy version', () => {
    const memory = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 1, markdown: 'D' },
      taskSearchResults: [],
      fullObservations: [],
    });
    const rec = buildPromptCompositionRecord({
      assignment: assignMemoryDigestArm('task-4711', 0),
      memory,
      promptText: 'prompt',
    });
    expect(rec.arm).toBe('full');
    expect(rec.propensity).toBe(1);
    expect(rec.fraction).toBe(0);
    expect(rec.policyVersion).toBe(MEMORY_DIGEST_POLICY_VERSION);
  });

  test('memoryShare is 0 rather than NaN for an empty prompt', () => {
    const rec = buildPromptCompositionRecord({
      assignment: assignMemoryDigestArm('task-4711', 0),
      memory: buildMemoryBlock({
        arm: 'full',
        compactResult: { count: 0 },
        taskSearchResults: [],
        fullObservations: [],
      }),
      promptText: '',
    });
    expect(rec.memoryShare).toBe(0);
    expect(Number.isNaN(rec.memoryShare)).toBe(false);
  });
});

describe('appendPromptCompositionEvent', () => {
  const record = () => buildPromptCompositionRecord({
    assignment: assignMemoryDigestArm('task-4711', 0),
    memory: buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 1, markdown: 'D' },
      taskSearchResults: [],
      fullObservations: [],
    }),
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
