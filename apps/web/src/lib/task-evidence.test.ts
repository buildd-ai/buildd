import { describe, it, expect } from 'bun:test';
import {
  buildTaskEvidence,
  classifyErrorClass,
  detectMismatches,
  extractKeyLines,
  sanitizeEvidenceText,
  EVIDENCE_MAX_KEY_LINES,
  EVIDENCE_MAX_LINE_CHARS,
  type EvidenceInput,
} from './task-evidence';
import { formatBashTraceExcerpt } from '@buildd/core/bash-failure-trace';

const NO_DIFF = { files: 0, added: 0, removed: 0 };
const T0 = new Date('2026-01-01T00:00:00Z');

function bashTrace(command: string, exitCode: number, output: string, at: number) {
  return {
    pattern: 'bash_nonzero_exit',
    excerpt: formatBashTraceExcerpt({ command, exitCode, output }),
    ts: new Date(T0.getTime() + at * 1000),
  };
}
function recovered(command: string, at: number) {
  return {
    pattern: 'bash_verify_recovered',
    excerpt: formatBashTraceExcerpt({ command, exitCode: 0, output: '' }),
    ts: new Date(T0.getTime() + at * 1000),
  };
}

function input(over: Partial<EvidenceInput> = {}): EvidenceInput {
  return {
    status: 'failed',
    summary: null,
    error: null,
    diff: NO_DIFF,
    traces: [],
    ciDigest: null,
    ciChecks: null,
    links: {},
    ...over,
  };
}

describe('sanitizeEvidenceText', () => {
  it('strips terminal escapes and redacts credentials', () => {
    const out = sanitizeEvidenceText('\u001b[31mfailed\u001b[0m with ghp_abcdefghijklmnopqrstuvwxyz0123 and Authorization: Bearer abc.def.ghi');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123');
    expect(out).not.toContain('abc.def.ghi');
    expect(out).toContain('failed');
  });
});

describe('extractKeyLines', () => {
  it('keeps signal lines and drops noise', () => {
    const lines = extractKeyLines('installing\nall good\n(fail) foo > bar\nerror: expected 1 received 2\ndone');
    expect(lines).toEqual(['(fail) foo > bar', 'error: expected 1 received 2']);
  });

  it('caps the count and keeps both the first and the last errors', () => {
    const text = Array.from({ length: 200 }, (_, i) => `error line ${i}`).join('\n');
    const lines = extractKeyLines(text);
    expect(lines.length).toBe(EVIDENCE_MAX_KEY_LINES);
    expect(lines[0]).toBe('error line 0');
    expect(lines[lines.length - 1]).toBe('error line 199');
  });

  it('clips over-long lines', () => {
    const [line] = extractKeyLines(`error: ${'x'.repeat(5000)}`);
    expect(line.length).toBeLessThanOrEqual(EVIDENCE_MAX_LINE_CHARS + 1);
  });

  it('falls back to the tail when nothing looks like an error', () => {
    const lines = extractKeyLines('a\nb\nc');
    expect(lines).toEqual(['a', 'b', 'c']);
  });
});

describe('classifyErrorClass', () => {
  it('names a compiler error before the test run it broke', () => {
    expect(classifyErrorClass('src/a.ts(3,1): error TS2322: nope\n(fail) x')).toBe('type_error');
  });
  it('recognises a ratchet', () => {
    expect(classifyErrorClass('ratchet: 3 new violations')).toBe('lint_ratchet');
  });
  it('recognises a test failure', () => {
    expect(classifyErrorClass('(fail) foo > bar')).toBe('test_failure');
  });
  it('recognises a timeout and auth', () => {
    expect(classifyErrorClass('operation timed out')).toBe('timeout');
    expect(classifyErrorClass('HTTP 401 Bad credentials')).toBe('auth');
  });
  it('names the agent CLI "not logged in" failure as auth, not unknown', () => {
    expect(classifyErrorClass('Not logged in · Please run /login')).toBe('auth');
    expect(classifyErrorClass('[mcp-sdk] noise\nnot logged in')).toBe('auth');
  });
  it('falls back to the scanner pattern label', () => {
    expect(classifyErrorClass('weird', ['command_not_found'])).toBe('infra');
  });
  it('is unknown when nothing matches', () => {
    expect(classifyErrorClass('hmm')).toBe('unknown');
  });
});

describe('buildTaskEvidence', () => {
  it('seeds keyLines from the CI digest when the task itself left no trace', () => {
    const digest = [
      'CI failed on PR #12: 2 checks failing',
      'Check: unit',
      '(fail) billing > rounds up',
      'error: expect(received).toBe(expected)',
    ].join('\n');
    const { evidence } = buildTaskEvidence(input({ ciDigest: digest }), T0);
    expect(evidence?.keyLinesSource).toBe('ci_digest');
    expect(evidence?.keyLines).toContain('(fail) billing > rounds up');
    expect(evidence?.errorClass).toBe('test_failure');
  });

  it('puts what the task hit first and the digest after', () => {
    const { evidence } = buildTaskEvidence(input({
      ciDigest: '(fail) digest test',
      traces: [bashTrace('bun test a.test.ts', 1, '(fail) local test', 1)],
    }), T0);
    expect(evidence?.keyLinesSource).toBe('traces');
    expect(evidence?.keyLines.indexOf('(fail) local test')).toBeLessThan(evidence!.keyLines.indexOf('(fail) digest test'));
  });

  it('redacts secrets in key lines and the last failing command', () => {
    const secret = 'ghp_abcdefghijklmnopqrstuvwxyz0123';
    const { evidence } = buildTaskEvidence(input({
      traces: [bashTrace(`curl -H "Authorization: Bearer ${secret}" https://x`, 22, `error: token ${secret} rejected`, 1)],
      ciDigest: `error: leaked ${secret}`,
    }), T0);
    const blob = JSON.stringify(evidence);
    expect(blob).not.toContain(secret);
    expect(evidence?.lastFailingCommand?.exitCode).toBe(22);
  });

  it('holds the size cap on a huge log', () => {
    const huge = Array.from({ length: 5000 }, (_, i) => `error: failure number ${i} ${'y'.repeat(400)}`).join('\n');
    const { evidence } = buildTaskEvidence(input({ ciDigest: huge, error: huge }), T0);
    expect(evidence!.keyLines.length).toBeLessThanOrEqual(EVIDENCE_MAX_KEY_LINES);
    for (const l of evidence!.keyLines) expect(l.length).toBeLessThanOrEqual(EVIDENCE_MAX_LINE_CHARS + 1);
    expect(JSON.stringify(evidence).length).toBeLessThan(20_000);
  });

  it('caps ciChecks', () => {
    const ciChecks = Array.from({ length: 60 }, (_, i) => ({ name: `job ${i}`, state: 'failed' as const, url: null }));
    const { evidence } = buildTaskEvidence(input({ ciChecks }), T0);
    expect(evidence!.ciChecks!.length).toBe(20);
  });

  it('leaves no evidence for a clean success', () => {
    const { evidence, mismatch } = buildTaskEvidence(input({
      status: 'completed',
      summary: 'Fixed the rounding bug',
      diff: { files: 2, added: 10, removed: 1 },
      ciChecks: [{ name: 'unit', state: 'passed', url: null }],
    }), T0);
    expect(evidence).toBeNull();
    expect(mismatch).toEqual([]);
  });
});

describe('detectMismatches', () => {
  const base = { status: 'completed' as const, summary: 'Done', diff: { files: 1, added: 1, removed: 0 }, traces: [], ciChecks: null };

  it('flags a "pushed" summary with a 0-file diff', () => {
    const m = detectMismatches({ ...base, summary: 'Pushed the fix to the branch', diff: NO_DIFF });
    expect(m.map(x => x.kind)).toEqual(['pushed_without_diff']);
  });

  it('does not flag a negated push', () => {
    expect(detectMismatches({ ...base, summary: 'Could not push the change', diff: NO_DIFF })).toEqual([]);
  });

  it('does not flag a pushed summary that has a diff', () => {
    expect(detectMismatches({ ...base, summary: 'Committed and pushed' })).toEqual([]);
  });

  it('flags success while a gating check is red', () => {
    const m = detectMismatches({ ...base, ciChecks: [{ name: 'unit', state: 'failed', url: null }, { name: 'lint', state: 'passed', url: null }] });
    expect(m.map(x => x.kind)).toEqual(['success_with_red_check']);
    expect(m[0].detail).toContain('unit');
  });

  it('does not flag a failed task for a red check', () => {
    expect(detectMismatches({ ...base, status: 'failed', ciChecks: [{ name: 'unit', state: 'failed', url: null }] })).toEqual([]);
  });

  it('flags a last test command that exited non-zero', () => {
    const m = detectMismatches({ ...base, traces: [bashTrace('bun run test', 1, '(fail) x', 1)] });
    expect(m.map(x => x.kind)).toEqual(['last_command_failed']);
  });

  it('does not flag when the same kind of command passed afterwards', () => {
    expect(detectMismatches({
      ...base,
      traces: [bashTrace('bun run test', 1, '(fail) x', 1), recovered('bun run test', 5)],
    })).toEqual([]);
  });

  it('ignores a failing non-verify command', () => {
    expect(detectMismatches({ ...base, traces: [bashTrace('cat missing.txt', 1, 'No such file', 1)] })).toEqual([]);
  });

  it('flags nothing on a clean run', () => {
    expect(detectMismatches({ ...base, summary: 'Pushed the fix', ciChecks: [{ name: 'unit', state: 'passed', url: null }] })).toEqual([]);
  });

  it('a mismatch on a completed task yields evidence', () => {
    const { evidence, mismatch } = buildTaskEvidence(input({
      status: 'completed',
      summary: 'Pushed the fix',
      traces: [],
    }), T0);
    expect(mismatch.map(m => m.kind)).toEqual(['pushed_without_diff']);
    expect(evidence).not.toBeNull();
  });
});

describe('evidence for a red-check mismatch', () => {
  const RED = [{ name: 'check', state: 'failed' as const, url: 'https://ci/1' }];
  const base = (over: Partial<EvidenceInput> = {}): EvidenceInput => ({
    status: 'completed', summary: 'Done, all green', error: null, diff: NO_DIFF,
    traces: [], ciDigest: null, ciChecks: RED, links: {}, ...over,
  });

  it('an exploratory grep exiting 2 is never the evidence: not the last failing command, not a test failure', () => {
    const { evidence, mismatch } = buildTaskEvidence(base({
      traces: [bashTrace('grep -rn "expect(" apps/web 2>/dev/null', 2, 'grep: apps/web/x: No such file or directory', 1)],
    }));
    expect(mismatch.map(m => m.kind)).toEqual(['success_with_red_check']);
    expect(evidence!.lastFailingCommand).toBeUndefined();
    expect(evidence!.errorClass).not.toBe('test_failure');
    expect(evidence!.keyLines.join('\n')).not.toContain('grep');
    expect(evidence!.ciChecks).toEqual(RED);
  });

  it('a real failing test still is', () => {
    const { evidence } = buildTaskEvidence(base({ traces: [bashTrace('bun test a.test.ts', 1, '(fail) a > b', 1)] }));
    expect(evidence!.lastFailingCommand?.command).toContain('bun test');
    expect(evidence!.errorClass).toBe('test_failure');
  });
});

describe('a CI-fix attempt verifies the check it was sent for', () => {
  const mk = (state: 'passed' | 'failed' | 'pending') => detectMismatches({
    status: 'completed', summary: 'Fixed. Tier-2 is passing.', diff: { files: 1, added: 2, removed: 1 }, traces: [],
    ciChecks: [{ name: 'check', state, url: null }, { name: 'Tier-2', state: 'passed', url: null }],
    fixCheck: 'check',
  });

  it('reporting success while its named check is red is flagged, naming the check', () => {
    const m = mk('failed').find(x => x.kind === 'fix_check_still_red');
    expect(m?.detail).toContain('check, the check this attempt was sent to fix, is still failing');
  });
  it('a pending named check is not green either', () => {
    expect(mk('pending').some(x => x.kind === 'fix_check_still_red')).toBe(true);
  });
  it('green on the named check passes', () => {
    expect(mk('passed').some(x => x.kind === 'fix_check_still_red')).toBe(false);
  });
});
