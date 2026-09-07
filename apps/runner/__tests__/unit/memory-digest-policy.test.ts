import { describe, expect, test } from 'bun:test';
import {
  FULL_DIGEST_MAX_BYTES,
  MEMORY_DIGEST_POLICY_VERSION,
  assignMemoryDigestArm,
  buildMemoryBlock,
  buildPromptCompositionRecord,
  hashUnitInterval,
  resolveTaskScopedFraction,
} from '../../src/memory-digest-policy';

const obs = (n: number) => Array.from({ length: n }, (_, i) => ({
  type: 'gotcha',
  title: `lesson ${i}`,
  content: `content ${i}`,
}));

/** The recall/learn pointer, copied literally so a source edit is visible. */
const RECALL_POINTER_LITERAL =
  '\n\nUse `recall scope=["memory","task"]` for full context (prior lessons + recent outcomes in one call). Use `learn` to record gotchas/patterns/decisions — NOT summaries.';

/**
 * Deterministic v4-UUID-shaped ids, which is the shape production uses
 * (`tasks.id` is `uuid().defaultRandom()`).
 *
 * Deterministic rather than `crypto.randomUUID()` so a distribution assertion
 * cannot flake, and UUID-shaped rather than `task-${i}` because FNV-1a is
 * measurably less uniform on ids that differ only in a short suffix — the old
 * sequential fixture read 0.086 at a configured 0.1, which is the sort of
 * skew that makes a rate assertion look broken when the code is fine.
 */
function uuidLikeIds(n: number): string[] {
  let s = 0x9e3779b9 >>> 0;
  const hex = () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5; s >>>= 0;
    return s.toString(16).padStart(8, '0');
  };
  return Array.from({ length: n }, () =>
    `${hex()}-${hex().slice(0, 4)}-4${hex().slice(0, 3)}-a${hex().slice(0, 3)}-${hex()}${hex().slice(0, 4)}`);
}

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

  test('an absent task id runs the control rather than an unstable draw', () => {
    expect(assignMemoryDigestArm(undefined, 1).arm).toBe('full');
    expect(assignMemoryDigestArm('', 1).arm).toBe('full');
  });

  test('propensity is the probability of the arm actually drawn', () => {
    for (const id of uuidLikeIds(400)) {
      const a = assignMemoryDigestArm(id, 0.3);
      expect(a.propensity).toBeCloseTo(a.arm === 'task_scoped' ? 0.3 : 0.7, 10);
    }
  });

  // THE test in this file. Everything else here would stay green if the
  // comparison were inverted (`draw < fraction` -> `draw > fraction`), because
  // 0.5 is symmetric under inversion and every other assertion reads the arm
  // out of the result and merely checks the returned fields agree with each
  // other. Inversion at fraction 0.1 enrols ~90% of the fleet — exactly the
  // runaway this module claims to prevent — so the realised RATE has to be
  // asserted, at an asymmetric fraction, on production-shaped ids.
  test('the realised enrolment rate matches the configured fraction', () => {
    const ids = uuidLikeIds(5000);
    for (const fraction of [0.1, 0.3, 0.5, 0.9]) {
      const rate = ids.filter(id => assignMemoryDigestArm(id, fraction).arm === 'task_scoped').length / ids.length;
      expect(rate).toBeGreaterThan(fraction - 0.02);
      expect(rate).toBeLessThan(fraction + 0.02);
    }
  });

  test('the hash spreads production-shaped ids across all ten deciles', () => {
    const buckets = new Array(10).fill(0);
    for (const id of uuidLikeIds(5000)) {
      buckets[Math.min(9, Math.floor(hashUnitInterval(id) * 10))]++;
    }
    // Uniform puts 500 in each. A hash that clumps — or one whose >>> 0 was
    // dropped, folding the negative half onto a narrow range — fails here.
    for (const count of buckets) {
      expect(count).toBeGreaterThan(380);
      expect(count).toBeLessThan(620);
    }
  });

  test('the draw stays inside [0, 1) for adversarial keys', () => {
    for (const key of ['', 'a', '\u0000', 'x'.repeat(10_000), '→→→', ...uuidLikeIds(200)]) {
      const h = hashUnitInterval(key);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(1);
    }
  });

  // Without the salt, bumping to v2 leaves every task on the arm it drew under
  // v1, so a v2 comparison inherits v1's assignment and any carry-over effect.
  test('the draw is salted with the policy version, not the bare task id', () => {
    const ids = uuidLikeIds(300);
    const differs = ids.filter(id => {
      const salted = assignMemoryDigestArm(id, 0.5).arm === 'task_scoped';
      const bare = hashUnitInterval(id) < 0.5;
      return salted !== bare;
    });
    // An unsalted implementation makes these agree for every single id.
    expect(differs.length).toBeGreaterThan(50);
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

  // The cap is part of the control's definition, so it is pinned as a LITERAL.
  // Expressing the fixture and the expectation in terms of the constant makes
  // the test invariant to the constant's value — 4096 could become 1024 and
  // every control prompt would silently lose 3KB of digest with CI green.
  test('the digest cap is 4096 code units', () => {
    expect(FULL_DIGEST_MAX_BYTES).toBe(4096);
  });

  // The blind slice is preserved deliberately: fixing it to fall on a line
  // boundary is an improvement, but doing it here would move the control while
  // the experiment is running.
  test('slices an oversized digest at the cap and appends the exact note', () => {
    const r = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 9, markdown: 'x'.repeat(4096 + 500) },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.digestTruncated).toBe(true);
    // Literal, including the two leading newlines — the block's shape depends
    // on them and nothing else in the suite pins the truncated rendering.
    expect(r.block).toBe(
      '## Workspace Memory\n'
      + 'x'.repeat(4096)
      + '\n\n*(truncated — use `recall` for more)*'
      + RECALL_POINTER_LITERAL,
    );
  });

  test('a digest of exactly the cap is not truncated', () => {
    const r = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 9, markdown: 'x'.repeat(4096) },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.digestTruncated).toBe(false);
    expect(r.block).not.toContain('truncated');
  });

  test('one code unit over the cap does truncate', () => {
    const r = buildMemoryBlock({
      arm: 'full',
      compactResult: { count: 9, markdown: 'x'.repeat(4097) },
      taskSearchResults: [],
      fullObservations: [],
    });
    expect(r.digestTruncated).toBe(true);
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
    // Asserted against the rendered block, not against the sibling field —
    // digestBytes and digestBytesAvailable are the same assignment in source,
    // so comparing them to each other cannot fail.
    expect(control.digestBytesAvailable).toBe(Buffer.byteLength('DIGEST BODY', 'utf8'));
    expect(treated.digestBytesAvailable).toBe(Buffer.byteLength('DIGEST BODY', 'utf8'));
    expect(treated.digestBytes).toBe(0);
  });

  // The counterfactual must include the truncation note, or the reported saving
  // understates the real one by the note's length.
  test('the counterfactual size covers the truncated rendering too', () => {
    const args = {
      compactResult: { count: 9, markdown: 'x'.repeat(4096 + 500) },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    };
    const control = buildMemoryBlock({ arm: 'full', ...args });
    const treated = buildMemoryBlock({ arm: 'task_scoped', ...args });
    const expected = 4096 + Buffer.byteLength('\n\n*(truncated — use `recall` for more)*', 'utf8');
    expect(control.digestBytesAvailable).toBe(expected);
    expect(treated.digestBytesAvailable).toBe(expected);
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
    // The removed span includes the joining newline, so a treatment that also
    // dropped a separator, or dropped one byte more, fails rather than passes.
    expect(control.replace('\nDIGEST BODY\nsecond line', '')).toBe(treated);
  });

  // The one-axis claim was previously only proven for a digest short enough
  // never to truncate — which is the exact case where a second axis could hide.
  test('still one axis when the digest truncates', () => {
    const args = {
      compactResult: { count: 3, markdown: 'x'.repeat(4096 + 500) },
      taskSearchResults: [{ id: '1' }],
      fullObservations: obs(1),
    };
    const control = buildMemoryBlock({ arm: 'full', ...args })!.block!;
    const treated = buildMemoryBlock({ arm: 'task_scoped', ...args })!.block!;
    const digestSpan = '\n' + 'x'.repeat(4096) + '\n\n*(truncated — use `recall` for more)*';
    expect(control.replace(digestSpan, '')).toBe(treated);
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
