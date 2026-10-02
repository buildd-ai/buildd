/**
 * Log-aware evidence chunker (docs/specs/byo-evidence-storage.md, "The
 * `evidence` corpus", build breakdown item 5).
 *
 * Only the error-bearing signal of a stored object is indexed, never the whole
 * log: failing tests with their assertion, error blocks with their stack, a
 * failing command's tail, a CI failure digest, the final agent summary.
 */
import { describe, it, expect } from 'bun:test';
import {
  chunkEvidenceLog,
  DEFAULT_MAX_EVIDENCE_CHUNKS,
  MAX_EVIDENCE_CHUNK_CHARS,
} from '../evidence-chunker';

// A credential-shaped token (generic pattern: ghp_ + 16+ chars). The runner's
// own redactor would normally have removed it before upload; the chunker's
// second pass must catch one that slipped through.
const SEEDED_SECRET = 'ghp_seededFixtureTokenAbCdEf0123456789';

/** A representative failing CI job log: setup noise, passing tests, two bun failures, a tsc error. */
const FAILING_LOG = [
  '2026-09-30T10:00:00.0000000Z ##[group]Run actions/checkout@v4',
  '2026-09-30T10:00:01.0000000Z Syncing repository: example/repo',
  '2026-09-30T10:00:02.0000000Z ##[endgroup]',
  '2026-09-30T10:00:03.0000000Z $ bun run scripts/run-unit-tests.ts',
  ...Array.from({ length: 200 }, (_, i) => `2026-09-30T10:00:04.0000000Z (pass) widget renderer > case ${i} [0.12ms]`),
  '2026-09-30T10:00:05.0000000Z apps/web/src/lib/ratchet.test.ts:',
  '2026-09-30T10:00:05.0000000Z (pass) ratchet > accepts equal baseline [0.20ms]',
  '2026-09-30T10:00:05.0000000Z 41 |   it("rejects a stale baseline", () => {',
  '2026-09-30T10:00:05.0000000Z 42 |     expect(readBaseline()).toBe(17);',
  '2026-09-30T10:00:05.0000000Z                                ^',
  '2026-09-30T10:00:05.0000000Z error: expect(received).toBe(expected)',
  '2026-09-30T10:00:05.0000000Z ',
  '2026-09-30T10:00:05.0000000Z Expected: 17',
  '2026-09-30T10:00:05.0000000Z Received: 19',
  '2026-09-30T10:00:05.0000000Z ',
  '2026-09-30T10:00:05.0000000Z       at <anonymous> (/home/runner/work/repo/apps/web/src/lib/ratchet.test.ts:42:30)',
  '2026-09-30T10:00:05.0000000Z (fail) ratchet > rejects a stale baseline [1.02ms]',
  '2026-09-30T10:00:06.0000000Z apps/runner/__tests__/unit/sync.test.ts:',
  `2026-09-30T10:00:06.0000000Z error: request to upstream failed with Authorization: token ${SEEDED_SECRET}`,
  '2026-09-30T10:00:06.0000000Z error: Test "sync > drains the queue" timed out after 5000ms',
  '2026-09-30T10:00:06.0000000Z (fail) sync > drains the queue [5001.00ms]',
  '2026-09-30T10:00:07.0000000Z $ tsc --noEmit',
  "2026-09-30T10:00:08.0000000Z apps/web/src/lib/widget.ts(12,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  '2026-09-30T10:00:09.0000000Z ##[error]Process completed with exit code 1.',
].join('\n');

describe('chunkEvidenceLog', () => {
  const chunks = chunkEvidenceLog({ text: FAILING_LOG, kind: 'ci_job_log' });

  it('turns each failing test into a chunk carrying its name, file and assertion', () => {
    const ratchet = chunks.find(c => c.testName === 'ratchet > rejects a stale baseline');
    expect(ratchet).toBeDefined();
    expect(ratchet!.errorClass).toBe('test_failure');
    expect(ratchet!.file).toBe('apps/web/src/lib/ratchet.test.ts');
    expect(ratchet!.content).toContain('Expected: 17');
    expect(ratchet!.content).toContain('Received: 19');
    // The passing test in the same file is not part of the failure block.
    expect(ratchet!.content).not.toContain('accepts equal baseline');

    const sync = chunks.find(c => c.testName === 'sync > drains the queue');
    expect(sync).toBeDefined();
    expect(sync!.file).toBe('apps/runner/__tests__/unit/sync.test.ts');
    expect(sync!.content).toContain('timed out after 5000ms');
  });

  it('splits on file boundaries: a failure never carries the previous file\'s lines', () => {
    const sync = chunks.find(c => c.testName === 'sync > drains the queue')!;
    expect(sync.content).not.toContain('Received: 19');
  });

  it('keeps a compiler error as its own chunk with the file it names', () => {
    const ts = chunks.find(c => c.errorClass === 'type_error');
    expect(ts).toBeDefined();
    expect(ts!.content).toContain('error TS2322');
    expect(ts!.file).toBe('apps/web/src/lib/widget.ts');
  });

  it('indexes the signal only, never the whole log', () => {
    const all = chunks.map(c => c.content).join('\n');
    expect(all).not.toContain('widget renderer > case');
    expect(all).not.toContain('Syncing repository');
    // Timestamps and the bare exit-code annotation are noise.
    expect(all).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/);
    expect(all).not.toContain('Process completed with exit code');
    expect(all.length).toBeLessThan(FAILING_LOG.length / 4);
  });

  it('runs a second redaction pass: a seeded secret reaches no chunk', () => {
    for (const c of chunks) expect(c.content).not.toContain(SEEDED_SECRET);
    expect(chunks.some(c => c.content.includes('[REDACTED'))).toBe(true);
  });

  it('applies a caller-supplied redactor on top (exact values)', () => {
    const exact = 'plain-lowercase-secret-value';
    const out = chunkEvidenceLog({
      text: `error: boom ${exact}\n    at run (src/a.ts:1:1)`,
      kind: 'command_output',
      secretValues: [exact],
    });
    expect(out.length).toBeGreaterThan(0);
    for (const c of out) expect(c.content).not.toContain(exact);
  });

  it('caps chunks per object at 40 by default', () => {
    expect(DEFAULT_MAX_EVIDENCE_CHUNKS).toBe(40);
    const many = Array.from({ length: 120 }, (_, i) =>
      [`src/f${i}.test.ts:`, `error: expect(received).toBe(expected) #${i}`, `(fail) suite ${i} > case [1ms]`].join('\n'),
    ).join('\n');
    const out = chunkEvidenceLog({ text: many, kind: 'test_report' });
    expect(out.length).toBe(40);
    expect(chunkEvidenceLog({ text: many, kind: 'test_report', maxChunks: 5 }).length).toBe(5);
  });

  it('bounds every chunk\'s size', () => {
    const huge = `error: giant\n${'    at frame (src/x.ts:1:1) '.repeat(2000)}`;
    for (const c of chunkEvidenceLog({ text: huge, kind: 'command_output' })) {
      expect(c.content.length).toBeLessThanOrEqual(MAX_EVIDENCE_CHUNK_CHARS);
    }
  });

  it('keeps a failing command\'s tail', () => {
    const out = chunkEvidenceLog({
      text: [...Array.from({ length: 100 }, (_, i) => `compiling module ${i}`), 'linker: undefined symbol _widget_init'].join('\n'),
      kind: 'command_output',
    });
    const tail = out.find(c => c.errorClass === 'command_tail');
    expect(tail).toBeDefined();
    expect(tail!.content).toContain('undefined symbol _widget_init');
    expect(tail!.content).not.toContain('compiling module 0\n');
  });

  it('adds a CI failure digest and the final agent summary when given', () => {
    const out = chunkEvidenceLog({
      text: 'nothing diagnostic here',
      kind: 'ci_job_log',
      digest: '2 of 90 unit test files failed:\n  ratchet.test.ts',
      summary: 'Pushed the baseline fix; tests pass locally.',
    });
    expect(out.find(c => c.errorClass === 'ci_digest')?.content).toContain('2 of 90 unit test files failed');
    expect(out.find(c => c.errorClass === 'summary')?.content).toContain('baseline fix');
  });

  it('returns nothing for a clean log (no fallback to the whole text)', () => {
    expect(chunkEvidenceLog({ text: '(pass) a > b [1ms]\nDone in 2s', kind: 'test_report' })).toEqual([]);
    expect(chunkEvidenceLog({ text: '', kind: 'command_output' })).toEqual([]);
  });

  it('dedupes identical blocks', () => {
    const line = "src/a.ts(1,1): error TS2304: Cannot find name 'x'.";
    const out = chunkEvidenceLog({ text: `${line}\nok\n\n\n${line}`, kind: 'ci_job_log' });
    expect(out.filter(c => c.errorClass === 'type_error').length).toBe(1);
  });
});
