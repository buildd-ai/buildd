import { describe, it, expect } from 'bun:test';
import { gzipSync } from 'zlib';
import {
  EVIDENCE_READ_CAP_BYTES,
  MAX_GREP_PATTERN_LENGTH,
  compileGrepPattern,
  decodeEvidenceBody,
  EvidenceReadError,
  openEvidenceObject,
  parseEvidenceReadParams,
  readEvidenceText,
} from './evidence-read';

async function* chunks(buf: Buffer, size = 64 * 1024): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

const lines = (n: number, f: (i: number) => string) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n');

function opts(q: string) {
  const r = parseEvidenceReadParams(new URLSearchParams(q));
  if (!r.ok) throw new Error(r.error);
  return r.options;
}

describe('parseEvidenceReadParams', () => {
  it('defaults to reading from line 1', () => {
    expect(opts('')).toEqual({ start: 1 });
  });

  it('parses tail, range and cursor', () => {
    expect(opts('tail=50')).toMatchObject({ tail: 50, start: 1 });
    expect(opts('range=10-20')).toMatchObject({ start: 10, end: 20 });
    expect(opts('range=10-')).toMatchObject({ start: 10 });
    expect(opts('cursor=42')).toMatchObject({ start: 42 });
  });

  it('rejects a bad tail, range or cursor', () => {
    for (const q of ['tail=0', 'tail=abc', 'tail=1000000', 'range=20-10', 'range=x', 'range=0-5', 'cursor=-1']) {
      expect(parseEvidenceReadParams(new URLSearchParams(q)).ok).toBe(false);
    }
  });

  it('rejects an invalid regex', () => {
    const r = parseEvidenceReadParams(new URLSearchParams('grep=(unclosed'));
    expect(r.ok).toBe(false);
  });
});

describe('compileGrepPattern', () => {
  it('rejects a pattern past the length cap', () => {
    expect(compileGrepPattern('a'.repeat(MAX_GREP_PATTERN_LENGTH + 1)).ok).toBe(false);
  });

  it('rejects nested quantifiers (catastrophic backtracking)', () => {
    for (const p of ['(a+)+$', '(a*)*b', '(\\w+\\s?)+$', '(x+x+)+y', '(a|aa)+{2}', '([a-z]+)*=']) {
      expect(compileGrepPattern(p).ok).toBe(false);
    }
  });

  it('rejects adjacent unbounded quantifiers (polynomial backtracking)', () => {
    for (const p of ['.*.*x', '\\s*\\s*x', 'a*a*b', '.+x.+y', '.*.*.*.*x', 'a{1,}b{2,}', '(?=.*a)(?=.*b)']) {
      const r = compileGrepPattern(p);
      expect(r.ok).toBe(false);
    }
  });

  it('rejects any quantifier on a group whose body has a quantifier or alternation', () => {
    for (const p of [
      '(?:\\s?){10}\\s*x', '(?:a?){16}b', '(?:a|b){12}c', '(?:\\s?){6}\\s*x', '(?:\\s?){16}x',
      '(?:x|x?){8}y', '(?:a|b)+c', '(?:x|x?)?y', '((?:a?))*b', '(?:(?:a|b)c){5}d', '(?=a?){9}b', '(a{2}){3}', '(?<n>a|b)+c',
    ]) {
      expect(compileGrepPattern(p).ok).toBe(false);
    }
  });

  it('rejects named backreferences', () => {
    expect(compileGrepPattern('(?<n>a)\\k<n>').ok).toBe(false);
  });

  it('rejects stacked optional and wide bounded repeats', () => {
    expect(compileGrepPattern('a?'.repeat(30) + 'a'.repeat(30)).ok).toBe(false);
    expect(compileGrepPattern('a{0,100}a{0,100}b').ok).toBe(false);
    expect(compileGrepPattern('x{1,5000}').ok).toBe(false);
  });

  it('fuzz: every accepted pattern runs over an adversarial 1 KB line in under 50 ms', () => {
    const pieces = ['a', 'a?', 'a*', 'a+', '\\s', '\\s?', '\\s*', '.', '.?', '.*', '[a ]', '[a ]?', '[a ]*', '(?:a|a)', '(?:a|\\s)',
      '(?:a?)', '(?:\\s?){4}', '(?:a|b){3}', 'a{0,7}', 'a{2,}', '(?=a*)', '(?!\\s?)', 'x', '(?:ab){0,9}', ' ?'];
    let seed = 7;
    const rand = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
    const handPicked = [' ?\\s ?\\s ?\\s*x', 'a?a?a?a*b', 'a{0,7}a*b', '(?:a|b|c|d|e|f|g|h)a*z', 'a?a?a?a?a?a?a?a?aaaaaaaab',
      '(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)(a|a)b', '(?=.*x)', '[\\s\\S]*x', '(?:ab){0,10}c'];
    const generated = Array.from({ length: 400 }, () => Array.from({ length: 1 + rand(6) }, () => pieces[rand(pieces.length)]).join('') + 'x');
    const lines = ['a'.repeat(1024), ' '.repeat(1024), 'a '.repeat(512), 'ab'.repeat(512)];
    let accepted = 0;
    for (const p of [...handPicked, ...generated]) {
      const c = compileGrepPattern(p);
      if (!c.ok) continue;
      accepted++;
      for (const line of lines) {
        const t0 = performance.now();
        c.re.test(line);
        const ms = performance.now() - t0;
        if (ms >= 50) throw new Error(`accepted pattern ${p} took ${ms.toFixed(0)} ms`);
      }
    }
    expect(accepted).toBeGreaterThan(50);
  });

  it('still accepts one unbounded quantifier, lazy suffixes and groups', () => {
    for (const p of ['error.*timeout', 'FAIL\\s+\\S', '(?:ERR|WARN)\\b', 'exit code [1-9]\\d?', 'a.*?b', '(?<k>key)=\\w+', 'x{2,4}y']) {
      expect(compileGrepPattern(p).ok).toBe(true);
    }
  });

  it('accepts ordinary patterns, case-insensitively', () => {
    const r = compileGrepPattern('fail(ed|ure)?');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.re.test('Test FAILED')).toBe(true);
  });
});

describe('readEvidenceText', () => {
  it('tail returns only the last N lines', async () => {
    const body = Buffer.from(lines(100, i => `line ${i}`));
    const r = await readEvidenceText(chunks(body, 7), opts('tail=3'));
    expect(r.text).toBe('line 98\nline 99\nline 100');
    expect(r.truncated).toBe(false);
    expect(r.fromLine).toBe(98);
    expect(r.toLine).toBe(100);
  });

  it('grep returns only matching lines, numbered', async () => {
    const body = Buffer.from(lines(10, i => (i % 3 === 0 ? `FAIL test ${i}` : `ok ${i}`)));
    const r = await readEvidenceText(chunks(body, 5), opts('grep=fail'));
    expect(r.text).toBe('3:FAIL test 3\n6:FAIL test 6\n9:FAIL test 9');
    expect(r.lineCount).toBe(3);
    expect(r.truncated).toBe(false);
    expect(r.cursor).toBeNull();
  });

  it('grep + tail keeps the last matching lines', async () => {
    const body = Buffer.from(lines(10, i => (i % 2 === 0 ? `error ${i}` : `ok ${i}`)));
    const r = await readEvidenceText(chunks(body), opts('grep=error&tail=2'));
    expect(r.text).toBe('8:error 8\n10:error 10');
  });

  it('range returns the requested lines only', async () => {
    const body = Buffer.from(lines(20, i => `l${i}`));
    const r = await readEvidenceText(chunks(body), opts('range=5-7'));
    expect(r.text).toBe('l5\nl6\nl7');
    expect(r.cursor).toBeNull();
  });

  it('a 10 MB object read by tail is capped at 64 KB with truncated=true', async () => {
    const body = Buffer.from(lines(100_000, i => `${String(i).padStart(8, '0')} ${'x'.repeat(91)}`));
    expect(body.length).toBeGreaterThan(10_000_000);
    const r = await readEvidenceText(chunks(body), opts('tail=10000'));
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(EVIDENCE_READ_CAP_BYTES);
    expect(r.truncated).toBe(true);
    expect(r.toLine).toBe(100_000);
    expect(r.text.endsWith(`00100000 ${'x'.repeat(91)}`)).toBe(true);
  });

  it('a 10 MB forward read is capped at 64 KB with a cursor that resumes where it stopped', async () => {
    const body = Buffer.from(lines(100_000, i => `${String(i).padStart(8, '0')} ${'x'.repeat(91)}`));
    const first = await readEvidenceText(chunks(body), opts(''));
    expect(Buffer.byteLength(first.text)).toBeLessThanOrEqual(EVIDENCE_READ_CAP_BYTES);
    expect(first.truncated).toBe(true);
    expect(first.cursor).toBe(String(first.toLine! + 1));

    const next = await readEvidenceText(chunks(body), opts(`cursor=${first.cursor}`));
    expect(next.fromLine).toBe(first.toLine! + 1);
    expect(next.text.startsWith(String(first.toLine! + 1).padStart(8, '0'))).toBe(true);
  });

  it('clips one enormous line instead of buffering it whole', async () => {
    const body = Buffer.from(`${'y'.repeat(5_000_000)}\nafter`);
    const r = await readEvidenceText(chunks(body), opts(''));
    expect(Buffer.byteLength(r.text)).toBeLessThanOrEqual(EVIDENCE_READ_CAP_BYTES);
    expect(r.text.split('\n')).toHaveLength(2);
    expect(r.text.endsWith('after')).toBe(true);
  });

  it('the worst accepted pattern over 4 KB lines finishes within a time bound', async () => {
    // One unbounded quantifier that never matches: quadratic in the grep window per line.
    const body = Buffer.from(lines(500, () => ' '.repeat(4096)));
    for (const p of ['\\s*x', '.*x', ' +x']) {
      const t0 = performance.now();
      const r = await readEvidenceText(chunks(body), opts(`grep=${encodeURIComponent(p)}`));
      expect(performance.now() - t0).toBeLessThan(3_000);
      expect(r.text).toBe('');
    }
  });

  it('with grep, checks the time budget on every line', async () => {
    let t = 0;
    const body = Buffer.from(lines(100, i => `row ${i}`));
    // Each call to now() advances 1 s; the budget is 5 s.
    const r = await readEvidenceText(chunks(body), opts('grep=row'), { now: () => (t += 1_000) });
    expect(r.truncated).toBe(true);
    expect(r.scannedLines).toBeLessThan(10);
    expect(r.cursor).toBe(String(r.scannedLines));
  });

  it('clips after redaction, so a secret straddling the clip is not half shown', async () => {
    const secret = 'sk-ant-api03-' + 'B'.repeat(90);
    const pad = 'p'.repeat(4096 - 20);
    const body = Buffer.from(`${pad} ${secret}\n`);
    const r = await readEvidenceText(chunks(body), opts(''));
    expect(r.text).not.toContain('sk-ant-api03-BBBB');
    expect(r.text.length).toBeLessThanOrEqual(4096);
  });

  it('redacts each line before grep runs and before it is returned', async () => {
    const secret = 'sk-ant-api03-' + 'A'.repeat(90);
    const body = Buffer.from(`ok\ntoken=${secret} failed\n`);
    const r = await readEvidenceText(chunks(body), opts('grep=failed'));
    expect(r.text).not.toContain(secret);
    expect(r.text).toContain('failed');
    const probe = await readEvidenceText(chunks(body), opts('grep=AAAAAAAAAA'));
    expect(probe.text).toBe('');
  });
});

describe('decodeEvidenceBody', () => {
  it('gunzips a gzip body and passes plain text through', async () => {
    const plain = lines(1000, i => `row ${i}`);
    const collect = async (src: AsyncIterable<Uint8Array>) => {
      const parts: Buffer[] = [];
      for await (const c of src) parts.push(Buffer.from(c));
      return Buffer.concat(parts).toString('utf8');
    };
    expect(await collect(decodeEvidenceBody(chunks(gzipSync(plain), 100)))).toBe(plain);
    expect(await collect(decodeEvidenceBody(chunks(Buffer.from(plain), 100)))).toBe(plain);
  });

  it('throws on a corrupt gzip body', async () => {
    const bad = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('not really gzip at all')]);
    const drain = async () => { for await (const _ of decodeEvidenceBody(chunks(bad))) { /* drain */ } };
    await expect(drain()).rejects.toThrow();
  });
});

describe('openEvidenceObject', () => {
  const row = (uploadState: string) => ({
    id: 'ev-1', workspaceId: 'ws-1', taskId: 't-1', rootTaskId: 't-1', workerId: 'w-1', prNumber: null,
    kind: 'command_output', backendId: null, objectKey: 'evidence/k.log.gz', bytes: 10, sha256: null,
    uploadState, indexState: 'queued', expiresAt: null, createdAt: new Date(), updatedAt: new Date(),
  }) as any;
  const client = { send: async () => ({ Body: chunks(gzipSync(Buffer.from('hello\n'))) }) };

  it('refuses a pending object by default', async () => {
    await expect(openEvidenceObject(row('pending'), { client, bucket: 'b' })).rejects.toBeInstanceOf(EvidenceReadError);
  });

  // Nothing confirms a runner PUT, so the indexer probes a pending row itself.
  it('opens a pending object when the caller accepts pending', async () => {
    const body = await openEvidenceObject(row('pending'), { client, bucket: 'b', acceptPending: true });
    let out = '';
    for await (const c of body) out += Buffer.from(c).toString();
    expect(out).toBe('hello\n');
  });

  it('still refuses a failed object when accepting pending', async () => {
    await expect(openEvidenceObject(row('failed'), { client, bucket: 'b', acceptPending: true })).rejects.toBeInstanceOf(EvidenceReadError);
  });
});
