import { describe, it, expect } from 'bun:test';
import { gzipSync } from 'zlib';
import {
  EVIDENCE_READ_CAP_BYTES,
  MAX_GREP_PATTERN_LENGTH,
  compileGrepPattern,
  decodeEvidenceBody,
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
