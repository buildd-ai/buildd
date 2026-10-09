/**
 * `workers.waiting_for.options` holds option OBJECTS ({ label, consequence,
 * recommended }) and, on older rows, plain strings. Hand-written casts like
 * `waitingFor as { prompt: string; options?: string[] }` told the compiler
 * they were strings, every fixture agreed, and the mission task sheet crashed
 * on a real question ("e.trim is not a function").
 *
 * The rule: read the raw column as `WaitingFor` from @buildd/shared (or the
 * schema's `WorkerWaitingFor`). A file may declare a `string[]` options shape
 * only if it builds that shape with `waitingForOptionLabels`.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const REPO = path.resolve(import.meta.dir, '../../../..');

/** Lines that claim a waitingFor's options are plain strings. */
export function stringOptionClaims(source: string): string[] {
  return source.split('\n').filter(line =>
    /waitingFor\??!?\s*(:|as)[^\n]*\boptions\??:\s*string\[\]/.test(line)
    || /\bas\s*\{[^}]*\bprompt\??:[^}]*\boptions\??:\s*string\[\]/.test(line),
  );
}

describe('waitingFor options shape guard', () => {
  it('catches the cast that caused the crash', () => {
    expect(stringOptionClaims(`waitingFor: (w.waitingFor as { type: string; prompt: string; options?: string[] } | null) ?? null,`)).toHaveLength(1);
    expect(stringOptionClaims(`  worker: { id: string; waitingFor: { prompt: string; options?: string[]; context?: string } | null } | null;`)).toHaveLength(1);
    expect(stringOptionClaims(`const wf = row.waitingFor as WaitingFor | null;`)).toHaveLength(0);
  });

  it('no source file claims raw options are strings without normalizing them', () => {
    const files = execFileSync('git', ['ls-files', 'apps/web/src', 'packages/core', 'packages/shared/src'], { cwd: REPO, encoding: 'utf8' })
      .split('\n')
      .filter(f => /\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && !/fixtures?/.test(f));
    const offenders: string[] = [];
    for (const f of files) {
      const src = readFileSync(path.join(REPO, f), 'utf8');
      if (src.includes('waitingForOptionLabels(')) continue;
      for (const line of stringOptionClaims(src)) offenders.push(`${f}: ${line.trim()}`);
    }
    expect(offenders).toEqual([]);
  });
});
