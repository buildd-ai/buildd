/**
 * The export CLI's argument handling. Its database half (refusing a path in
 * the repo, the flags, sanitizing, the round trip) runs against real Postgres
 * in apps/web/tests/db/kernel-corpus.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertOutsideRepo } from '../../apps/web/src/lib/workflow/testing/corpus-export';
import { main, parseArgs } from './export-kernel-corpus';

describe('export-kernel-corpus arguments', () => {
  test('parses every flag', () => {
    expect(parseArgs(['--db-url-file', 'f', '--out', 'o', '--since', '2026-09-01', '--limit', '5', '--errors-first', '--workspace', 'w']))
      .toEqual({ dbUrlFile: 'f', out: 'o', since: '2026-09-01', limit: 5, errorsFirst: true, workspace: 'w' });
    expect(parseArgs([])).toMatchObject({ limit: 200, errorsFirst: false });
  });

  test('refuses an unknown flag or a missing value', () => {
    expect(() => parseArgs(['--nope'])).toThrow(/unknown argument/);
    expect(() => parseArgs(['--out', '--errors-first'])).toThrow(/needs a value/);
  });

  test('refuses to run without an output path or a database', async () => {
    await expect(main([], {})).rejects.toThrow(/--out/);
    await expect(main(['--out', join(tmpdir(), 'x.jsonl')], {})).rejects.toThrow(/DATABASE_URL/);
  });

  test('an output path inside this repository is refused before any read', () => {
    expect(() => assertOutsideRepo(join(import.meta.dir, 'corpus.jsonl'))).toThrow(/inside a git work tree/);
    expect(() => assertOutsideRepo(join(tmpdir(), 'kernel-corpus.jsonl'))).not.toThrow();
  });
});
