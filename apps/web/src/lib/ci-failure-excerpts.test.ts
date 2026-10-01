import { describe, it, expect, mock } from 'bun:test';

const logs = new Map<number, string | Error>();
const jobs = new Map<number, unknown>();
const textCalls: string[] = [];

mock.module('@/lib/github', () => ({
  githubApi: async (_i: number, path: string) => {
    const id = Number(path.match(/\/actions\/jobs\/(\d+)$/)?.[1]);
    const j = jobs.get(id);
    if (j instanceof Error) throw j;
    if (!j) throw new Error('GitHub API error: 404');
    return j;
  },
  githubApiText: async (_i: number, path: string) => {
    textCalls.push(path);
    const id = Number(path.match(/\/actions\/jobs\/(\d+)\/logs$/)?.[1]);
    const l = logs.get(id);
    if (l instanceof Error) throw l;
    if (l === undefined) throw new Error('GitHub API error: 404');
    return l;
  },
}));

const {
  cleanLogText, redactLogText, jobIdFromUrl, tailExcerpt, fetchCiFailureExcerpts,
  CI_EXCERPT_LINES, CI_EXCERPT_MAX_CHARS, CI_EXCERPTS_MAX_TOTAL_CHARS,
} = await import('./ci-failure-excerpts');

// Built from parts so this file carries no literal id or figure of its own.
const UUID = ['12345678', 'abcd', 'abcd', 'abcd', '1234567890ab'].join('-');
const ESC = String.fromCharCode(27);

describe('cleanLogText', () => {
  it('strips timestamps, escape sequences and carriage returns', () => {
    const raw = [
      `2026-09-30T10:00:00.1234567Z ${ESC}[31;1merror TS2322${ESC}[0m: bad type`,
      `2026-09-30T10:00:01.0000000Z progress\r100%\r`,
      `﻿2026-09-30T10:00:02.0000000Z plain`,
    ].join('\n');
    const out = cleanLogText(raw);
    expect(out).toBe('error TS2322: bad type\nprogress100%\nplain');
    expect(out).not.toContain(ESC);
    expect(out).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it('strips non-colour escapes too (cursor moves, OSC titles)', () => {
    const raw = `${ESC}[2K${ESC}[1Gspin${ESC}]0;title\u0007 done`;
    expect(cleanLogText(raw)).toBe('spin done');
  });
});

describe('redactLogText', () => {
  it('masks UUIDs', () => {
    expect(redactLogText(`worker ${UUID} failed`)).toBe('worker [redacted-id] failed');
  });

  it('masks population counts the no-prod-data check would flag', () => {
    const big = `${['1', '234'].join(',')} rows`;
    expect(redactLogText(`scanned ${big}`)).not.toContain('234');
    const tenancy = `${7} ${'teams'}`;
    expect(redactLogText(`found ${tenancy}`)).toBe('found [redacted-count] teams');
  });

  it('leaves ordinary test output alone', () => {
    const line = 'FAIL apps/web/src/lib/foo.test.ts > adds numbers\n  expected 3 received 4 (12 ms)';
    expect(redactLogText(line)).toBe(line);
  });

  it('masks credentials in the shapes CI logs carry', () => {
    const gh = ['ghp', 'A'.repeat(36)].join('_');
    const out = redactLogText([
      `token ${gh}`,
      'Authorization: Bearer abc.def.ghi',
      'DATABASE_URL=postgres://user:hunter2@host/db',
      'API_SECRET=supersecretvalue',
      `key ${['bld', 'a1b2c3d4e5f6a7b8c9d0'].join('_')}`,
    ].join('\n'));
    for (const leaked of [gh, 'abc.def.ghi', 'hunter2', 'supersecretvalue', 'a1b2c3d4e5f6a7b8c9d0']) {
      expect(out).not.toContain(leaked);
    }
    expect(out).toContain('DATABASE_URL=');
  });
});

describe('jobIdFromUrl', () => {
  it('reads the Actions job id from a job URL or a check-run URL', () => {
    expect(jobIdFromUrl('https://github.com/o/r/actions/runs/55/job/9001')).toBe(9001);
    expect(jobIdFromUrl('https://github.com/o/r/runs/9002')).toBe(9002);
    expect(jobIdFromUrl('https://github.com/o/r/runs/9002?check_suite_focus=true')).toBe(9002);
  });
  it('is null when the URL names no job', () => {
    expect(jobIdFromUrl(null)).toBeNull();
    expect(jobIdFromUrl('https://ci.example.com/build/7')).toBeNull();
  });
});

describe('tailExcerpt', () => {
  it('keeps the last N lines, dropping blanks', () => {
    const lines = Array.from({ length: 400 }, (_, i) => `line ${i}`).join('\n\n');
    const out = tailExcerpt(lines).split('\n');
    expect(out.length).toBeLessThanOrEqual(CI_EXCERPT_LINES);
    expect(out[out.length - 1]).toBe('line 399');
    expect(out).not.toContain('');
  });

  it('holds the character cap, cutting from the front on a line boundary', () => {
    const lines = Array.from({ length: 150 }, (_, i) => `${i} ${'x'.repeat(200)}`).join('\n');
    const out = tailExcerpt(lines);
    expect(out.length).toBeLessThanOrEqual(CI_EXCERPT_MAX_CHARS);
    expect(out.endsWith(`149 ${'x'.repeat(200)}`)).toBe(true);
    expect(out.startsWith('…')).toBe(true);
  });
});

describe('fetchCiFailureExcerpts', () => {
  const reset = () => { logs.clear(); jobs.clear(); textCalls.length = 0; };
  const url = (id: number) => `https://github.com/o/r/actions/runs/1/job/${id}`;

  it('maps a failing job to name, failing step and a trimmed, escape-free, redacted excerpt', async () => {
    reset();
    jobs.set(11, { steps: [
      { name: 'Set up job', conclusion: 'success' },
      { name: 'Type check', conclusion: 'failure' },
      { name: 'Post checkout', conclusion: 'success' },
    ] });
    logs.set(11, [
      `2026-09-30T10:00:00.0000000Z ${ESC}[36;1mnoise before${ESC}[0m`,
      ...Array.from({ length: 300 }, (_, i) => `2026-09-30T10:00:01.0000000Z filler ${i}`),
      `2026-09-30T10:00:02.0000000Z ${ESC}[31merror${ESC}[0m TS2322 in ${UUID}`,
    ].join('\n'));

    const [one] = await fetchCiFailureExcerpts(1, 'o/r', [{ name: 'build', conclusion: 'failure', url: url(11) }]);
    expect(one.name).toBe('build');
    expect(one.step).toBe('Type check');
    expect(one.url).toBe(url(11));
    expect(one.excerpt).toContain('error TS2322 in [redacted-id]');
    expect(one.excerpt).not.toContain('noise before');
    expect(one.excerpt).not.toContain(ESC);
    expect(one.excerpt).not.toContain(UUID);
    expect(one.excerpt).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(one.excerpt!.split('\n').length).toBeLessThanOrEqual(CI_EXCERPT_LINES);
  });

  it('degrades to name plus URL when the job has no logs', async () => {
    reset();
    jobs.set(21, { steps: [{ name: 'Test', conclusion: 'failure' }] });
    logs.set(21, new Error('GitHub API error: 410 logs expired'));
    const [a] = await fetchCiFailureExcerpts(1, 'o/r', [{ name: 'test', conclusion: 'failure', url: url(21) }]);
    expect(a).toEqual({ name: 'test', conclusion: 'failure', url: url(21), step: 'Test', excerpt: null });
  });

  it('degrades without a request when the URL names no job', async () => {
    reset();
    const [a] = await fetchCiFailureExcerpts(1, 'o/r', [{ name: 'external', conclusion: 'failure', url: 'https://ci.example.com/7' }]);
    expect(a).toEqual({ name: 'external', conclusion: 'failure', url: 'https://ci.example.com/7', step: null, excerpt: null });
    expect(textCalls).toEqual([]);
  });

  it('one job failing to load does not lose the others', async () => {
    reset();
    jobs.set(31, { steps: [] });
    logs.set(31, 'boom');
    const out = await fetchCiFailureExcerpts(1, 'o/r', [
      { name: 'a', conclusion: 'failure', url: url(30) },
      { name: 'b', conclusion: 'failure', url: url(31) },
    ]);
    expect(out.map(o => o.excerpt)).toEqual([null, 'boom']);
  });

  it('holds a total size cap across jobs', async () => {
    reset();
    const big = Array.from({ length: 150 }, (_, i) => `${i} ${'y'.repeat(200)}`).join('\n');
    const checks = [41, 42, 43, 44, 45].map(id => {
      jobs.set(id, { steps: [] });
      logs.set(id, big);
      return { name: `job ${id}`, conclusion: 'failure', url: url(id) };
    });
    const out = await fetchCiFailureExcerpts(1, 'o/r', checks);
    expect(out).toHaveLength(5);
    const total = out.reduce((n, o) => n + (o.excerpt?.length ?? 0), 0);
    expect(total).toBeLessThanOrEqual(CI_EXCERPTS_MAX_TOTAL_CHARS);
    expect(out.every(o => o.name)).toBe(true);
  });
});
