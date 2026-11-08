import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ToolTraceRecorder, classifyShellForTrace, deriveResult, parseSearchArgs, pruneTraceDir, redactExcerpt,
  summarizeToolTrace, toolTraceConfigFromEnv, TRACE_SCHEMA_VERSION, type TraceEvent,
} from '../../src/tool-trace';

const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'tool-trace-')); dirs.push(d); return d; };

let t = 1000;
const mk = (extra: Record<string, unknown> = {}) => new ToolTraceRecorder({ taskId: 'task-1', attempt: 2, harness: 'claude', model: 'm', root: '/repo', now: () => (t += 10), ...extra });
let n = 0;
/** One complete call: tool_use then tool_result. */
function call(r: ToolTraceRecorder, name: string, input: unknown, text: string | null, extra: { is_error?: boolean; meta?: any; id?: string } = {}): TraceEvent {
  const id = extra.id ?? `c${++n}`;
  r.onToolUse({ id, name, input });
  r.onToolResult({ tool_use_id: id, content: text ?? [{ type: 'image' }], ...(extra.is_error ? { is_error: true } : {}), ...(extra.meta ? { tool_result_meta: extra.meta } : {}) });
  return r.events.find(e => e.callId === id)!;
}
const sh = (r: ToolTraceRecorder, command: string, text: string, is_error = false) => call(r, 'Bash', { command }, text, { is_error });

describe('classification', () => {
  test('native tools map to categories and origin', () => {
    const r = mk();
    expect(call(r, 'Grep', { pattern: 'foo' }, 'a.ts').category).toBe('search');
    expect(call(r, 'Glob', { pattern: '*.ts' }, 'a.ts').category).toBe('find');
    expect(call(r, 'Read', { file_path: '/repo/a.ts' }, 'x').category).toBe('read');
    expect(call(r, 'Edit', { file_path: '/repo/a.ts' }, 'ok').category).toBe('write');
    expect(call(r, 'mcp__buildd__buildd_work', { action: 'x' }, 'ok').category).toBe('mcp');
  });

  test('shell rg / grep / git grep are searches, Codex lowercase and argv forms included', () => {
    const r = mk();
    for (const c of ['rg foo src', 'grep -rn foo src', 'git grep foo -- src']) {
      const e = sh(r, c, 'src/a.ts:1:foo');
      expect(e.category).toBe('search');
      expect(e.searchRole).toBe('repo_search');
    }
    expect(call(r, 'bash', { command: ['bash', '-lc', 'rg foo'] }, 'x').category).toBe('search');
  });

  test('grep filtering ps or test output is not a repo search', () => {
    expect(classifyShellForTrace('ps aux | grep bun')).toMatchObject({ category: 'shell_other', searchRole: 'output_filter' });
    expect(classifyShellForTrace('bun run test | grep -i fail')).toMatchObject({ category: 'test', searchRole: 'output_filter' });
    expect(classifyShellForTrace('cat a.ts | grep foo').searchRole).toBe('repo_search');
  });

  test('unsupported parsing is unknown, never a confident guess', () => {
    for (const c of ['eval "$X"', '$TOOL foo bar', 'cat <<EOF\nrg x\nEOF', "rg 'unterminated", 'my-custom-script --go', 'x'.repeat(5000)]) {
      expect(classifyShellForTrace(c).category).toBe('unknown');
    }
    expect(classifyShellForTrace('cd src && echo hi').category).toBe('shell_other');
  });

  test('parseSearchArgs keeps whitelisted flags, not values, and flags a partial parse', () => {
    const p = parseSearchArgs(['-rn', '--glob', '*.ts', '-m', '5', 'needle', '/repo/src', '--weird'], '/repo');
    expect(p.scope.paths).toEqual(['src']);
    expect(p.scope.options).toEqual(['--glob', '-m', '-n', '-r']);
    expect(JSON.stringify(p.scope)).not.toContain('*.ts');
    expect(p.limit).toBe(5);
    expect(p.scope.parse).toBe('partial');
    expect(parseSearchArgs(['--help']).scope.parse).toBe('none');
  });
});

describe('result semantics', () => {
  const shellSearch = { category: 'search' as const, origin: 'shell' as const, single: true, searchFamily: 'rg', limit: null };
  test('rg exit 1 is no_matches, exit 2 is error', () => {
    expect(deriveResult(shellSearch, { text: 'Exit code 1', isError: true }).outcome).toBe('no_matches');
    expect(deriveResult(shellSearch, { text: 'Exit code 2\nregex parse error', isError: true }).outcome).toBe('error');
    expect(deriveResult(shellSearch, { text: 'Exit code 1', isError: true }).exitCodeBasis).toBe('parsed_text');
  });
  test('structured exit code beats text', () => {
    const d = deriveResult(shellSearch, { text: '', isError: true, exitCode: 1 });
    expect([d.outcome, d.exitCodeBasis]).toEqual(['no_matches', 'structured']);
  });
  test('success with no exit code shown is inferred 0; empty output is distinguished', () => {
    const d = deriveResult(shellSearch, { text: '', isError: false });
    expect([d.outcome, d.exitCode, d.exitCodeBasis]).toEqual(['empty_output', 0, 'inferred']);
  });
  test('unavailable path, OS denial, harness denial, timeout, cancel', () => {
    expect(deriveResult(shellSearch, { text: 'Exit code 2\nrg: nope: No such file or directory', isError: true }).outcome).toBe('path_unavailable');
    const os = deriveResult(shellSearch, { text: 'Exit code 2\nPermission denied', isError: true });
    expect([os.outcome, os.denial]).toEqual(['denied', 'os']);
    const pol = deriveResult(shellSearch, { text: 'blocked', isError: true, nonExecutionKind: 'permission_denied' });
    expect([pol.outcome, pol.denial]).toEqual(['denied', 'policy']);
    expect(deriveResult(shellSearch, { text: 'Exit code 124\nCommand timed out', isError: true }).outcome).toBe('timeout');
    expect(deriveResult(shellSearch, { text: 'Exit code 130', isError: true }).outcome).toBe('cancelled');
  });
  test('words in a successful result do not become failures', () => {
    expect(deriveResult(shellSearch, { text: 'src/a.ts:3: // permission denied handler, timeout', isError: false }).outcome).toBe('ok');
  });
  test('pipeline or chain with nonzero exit is not given search semantics', () => {
    const d = deriveResult({ ...shellSearch, single: false }, { text: 'Exit code 1', isError: true });
    expect(d.outcome).toBe('nonzero_unmodeled');
  });
  test('native search with no hits is no_matches', () => {
    const r = mk();
    expect(call(r, 'Grep', { pattern: 'zzz' }, 'No matches found').outcome).toBe('no_matches');
    expect(call(r, 'Glob', { pattern: '*.zz' }, '').outcome).toBe('no_matches');
  });
});

describe('truncation, limits and missing data', () => {
  test('harness truncation marks bytes as estimated', () => {
    const r = mk();
    const e = sh(r, 'cat big.log', 'line\n'.repeat(10) + '... [4000 lines truncated]');
    expect(e.truncated).toBe(true);
    expect(e.output.basis).toBe('estimated');
  });
  test('output bytes and lines are measured; limit hit sets truncated', () => {
    const r = mk();
    const e = call(r, 'Grep', { pattern: 'x', head_limit: 3 }, 'a\nb\nc\n');
    expect(e.output).toEqual({ bytes: 6, lines: 3, basis: 'measured' });
    expect(e.limit).toBe(3);
    expect(e.truncated).toBe(true);
  });
  test('non-text result has absent basis, not zero', () => {
    const e = call(mk(), 'Read', { file_path: '/repo/i.png' }, null);
    expect(e.output).toEqual({ bytes: null, lines: null, basis: 'absent' });
  });
  test('a call with no result is recorded as unobserved at close', () => {
    const r = mk();
    r.onToolUse({ id: 'lost', name: 'Bash', input: { command: 'rg foo' } });
    r.close();
    const e = r.events.find(x => x.callId === 'lost')!;
    expect([e.resultObserved, e.outcome, e.elapsedMs, e.exitCodeBasis]).toEqual([false, 'unobserved', null, 'absent']);
    expect(r.counters.unobserved).toBe(1);
  });
});

describe('repetition and change awareness', () => {
  test('an identical search repeats unchanged', () => {
    const r = mk();
    sh(r, 'rg needle src', 'x');
    const e = sh(r, 'rg needle src', 'x');
    expect(e.repeat).toMatchObject({ kind: 'repeat_unchanged', priorCount: 1 });
  });
  test('an edit under the searched scope makes the repeat after_change', () => {
    const r = mk();
    sh(r, 'rg needle src', 'x');
    call(r, 'Edit', { file_path: '/repo/src/a.ts' }, 'ok');
    expect(sh(r, 'rg needle src', 'x').repeat.kind).toBe('repeat_after_change');
  });
  test('an edit elsewhere does not invalidate', () => {
    const r = mk();
    sh(r, 'rg needle src', 'x');
    call(r, 'Edit', { file_path: '/repo/docs/a.md' }, 'ok');
    expect(sh(r, 'rg needle src', 'x').repeat.kind).toBe('repeat_unchanged');
  });
  test('re-reading an edited file is after_change, an untouched one is unchanged', () => {
    const r = mk();
    call(r, 'Read', { file_path: '/repo/a.ts' }, 'x');
    call(r, 'Read', { file_path: '/repo/b.ts' }, 'x');
    call(r, 'Edit', { file_path: '/repo/a.ts' }, 'ok');
    expect(call(r, 'Read', { file_path: '/repo/a.ts' }, 'x').repeat.kind).toBe('repeat_after_change');
    expect(call(r, 'Read', { file_path: '/repo/b.ts' }, 'x').repeat.kind).toBe('repeat_unchanged');
  });
  test('a failed edit invalidates nothing; a shell write or git checkout invalidates everything', () => {
    const r = mk();
    sh(r, 'rg needle', 'x');
    call(r, 'Edit', { file_path: '/repo/a.ts' }, 'String not found', { is_error: true });
    expect(sh(r, 'rg needle', 'x').repeat.kind).toBe('repeat_unchanged');
    sh(r, 'git checkout other-branch', 'Switched');
    expect(sh(r, 'rg needle', 'x').repeat.kind).toBe('repeat_after_change');
  });
  test('different flags or scope are different fingerprints', () => {
    const r = mk();
    const a = sh(r, 'rg needle src', 'x');
    const b = sh(r, 'rg -i needle src', 'x');
    const c = sh(r, 'rg needle docs', 'x');
    expect(new Set([a.fingerprint, b.fingerprint, c.fingerprint]).size).toBe(3);
    expect(b.repeat.kind).toBe('none');
  });
  test('prior outcome travels with the repeat', () => {
    const r = mk();
    sh(r, 'rg needle', 'Exit code 1', true);
    expect(sh(r, 'rg needle', 'Exit code 1', true).repeat.priorOutcome).toBe('no_matches');
  });
  test('fingerprints are salted per trace and carry no raw query', () => {
    const a = mk(); const b = mk();
    const ea = sh(a, 'rg SECRET_NEEDLE', 'x'); const eb = sh(b, 'rg SECRET_NEEDLE', 'x');
    expect(ea.fingerprint).not.toBe(eb.fingerprint);
    expect(JSON.stringify(ea)).not.toContain('SECRET_NEEDLE');
  });
});

describe('redaction and privacy', () => {
  test('no excerpt by default; raw command never stored', () => {
    const r = mk();
    sh(r, 'curl -H "Authorization: Bearer abcdefghijklmnop123456" https://x', 'ok');
    expect(JSON.stringify(r.events)).not.toContain('abcdefghijklmnop');
    expect(r.events[0].excerpt).toBeUndefined();
  });
  test('opted-in excerpts are redacted and bounded', () => {
    const r = mk({ captureExcerpts: true, excerptChars: 60, redact: (s: string) => s.replace(/hunter2/g, '***') });
    sh(r, 'echo hunter2 token=sk-abcdefghijklmnopqrstuvwx bld_abcdefgh1234', 'ok');
    const x = r.events[0].excerpt!;
    expect(x.length).toBeLessThanOrEqual(60);
    for (const leak of ['hunter2', 'sk-abcdef', 'bld_abcdefgh']) expect(x).not.toContain(leak);
  });
  test('redactExcerpt survives a throwing redactor and still scrubs', () => {
    expect(redactExcerpt('ghp_abcdefghijklmnopqrstuvwxyz', () => { throw new Error('x'); })).toBe('[redacted]');
  });
  test('platform summary has enum counts only', () => {
    const r = mk({ captureExcerpts: true });
    sh(r, 'rg needle src/secret-area', 'x');
    r.close();
    const json = JSON.stringify(summarizeToolTrace(r));
    for (const leak of ['needle', 'secret-area', r.events[0].fingerprint!]) expect(json).not.toContain(leak);
    expect(summarizeToolTrace(r).byCategory.search).toBe(1);
  });
});

describe('persistence, idempotency and bounds', () => {
  test('file is 0600 in a 0700 dir, header first, and ids are written once', () => {
    const dir = join(tmp(), 'traces');
    const r = mk({ persistDir: dir });
    sh(r, 'rg a', 'x', false);
    r.onToolResult({ tool_use_id: 'c-dup', content: 'late' }); // unknown id: ignored
    r.close(); r.close();
    if (process.platform !== 'win32') { // Windows has no POSIX mode bits
      expect(statSync(r.path!).mode & 0o777).toBe(0o600);
      expect(statSync(dir).mode & 0o777).toBe(0o700);
    }
    const lines = readFileSync(r.path!, 'utf8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines[0]).toMatchObject({ kind: 'header', v: TRACE_SCHEMA_VERSION, taskId: 'task-1', attempt: 2, harness: 'claude', model: 'm' });
    expect(lines.filter(l => l.kind === 'call')).toHaveLength(1);
    expect(lines.filter(l => l.kind === 'summary')).toHaveLength(1);
  });
  test('the same call id twice records one event', () => {
    const r = mk();
    call(r, 'Bash', { command: 'rg a' }, 'x', { id: 'same' });
    call(r, 'Bash', { command: 'rg a' }, 'x', { id: 'same' });
    expect(r.events).toHaveLength(1);
  });
  test('a resumed recorder does not rewrite calls already on disk', () => {
    const dir = tmp();
    const a = mk({ persistDir: dir });
    call(a, 'Bash', { command: 'rg a' }, 'x', { id: 'persisted' }); a.close();
    const b = mk({ persistDir: dir });
    call(b, 'Bash', { command: 'rg a' }, 'x', { id: 'persisted' }); b.close();
    const calls = readFileSync(a.path!, 'utf8').trim().split('\n').map(l => JSON.parse(l)).filter(l => l.kind === 'call');
    expect(calls).toHaveLength(1);
    expect(b.events).toHaveLength(0);
  });
  test('event cap and sampling are counted, not silent', () => {
    const r = mk({ maxEvents: 10, sampleAfter: 4, sampleEvery: 2 });
    for (let i = 0; i < 20; i++) call(r, 'Bash', { command: `echo ${i}` }, 'x');
    expect(r.events.length).toBeLessThanOrEqual(10);
    expect(r.counters.droppedByEventCap).toBeGreaterThan(0);
    expect(r.counters.sampledOut).toBeGreaterThan(0);
    expect(r.counters.recorded + r.counters.droppedByEventCap + r.counters.sampledOut).toBe(20);
  });
  test('byte cap drops are counted', () => {
    const r = mk({ maxBytes: 600 });
    for (let i = 0; i < 10; i++) call(r, 'Bash', { command: `echo ${i}` }, 'x');
    expect(r.counters.droppedByByteCap).toBeGreaterThan(0);
  });
  test('events past the cap are counted, not stored', () => {
    const r = mk({ maxEvents: 1 });
    sh(r, 'rg needle', 'x');
    sh(r, 'echo pad', 'x');
    expect(sh(r, 'rg needle', 'x')).toBeUndefined();
    expect(r.counters.droppedByEventCap).toBe(2);
    // the third call was dropped from storage but its repeat was still computed against the first
    expect(r.counters.recorded).toBe(1);
  });
  test('fingerprint table is bounded with an eviction counter', () => {
    const r = mk({ maxFingerprints: 3 });
    for (let i = 0; i < 6; i++) sh(r, `rg term${i}`, 'x');
    expect(r.counters.fingerprintEvictions).toBe(3);
  });
  test('pruneTraceDir removes old and surplus files', () => {
    const dir = tmp();
    for (const f of ['a', 'b', 'c']) writeFileSync(join(dir, `${f}.jsonl`), '{}');
    const old = new Date(Date.now() - 30 * 86_400_000);
    utimesSync(join(dir, 'a.jsonl'), old, old);
    expect(pruneTraceDir(dir, { maxAgeDays: 7, maxFiles: 1 })).toBe(2);
    expect(existsSync(join(dir, 'a.jsonl'))).toBe(false);
  });
  test('never throws on garbage input', () => {
    const r = mk();
    expect(() => { r.onToolUse({ name: '' } as any); r.onToolUse(null as any); r.onToolResult(null as any); r.onToolUse({ id: 'g', name: 'Bash', input: { command: 42 } }); r.close(); }).not.toThrow();
  });
  test('env config: memory by default, off, opt-in dir and excerpts', () => {
    expect(toolTraceConfigFromEnv({})).toEqual({ enabled: true, captureExcerpts: false });
    expect(toolTraceConfigFromEnv({ BUILDD_TOOL_TRACE: 'off' }).enabled).toBe(false);
    expect(toolTraceConfigFromEnv({ BUILDD_TOOL_TRACE_DIR: '/x', BUILDD_TOOL_TRACE_EXCERPTS: '1' })).toEqual({ enabled: true, persistDir: '/x', captureExcerpts: true });
  });
});
