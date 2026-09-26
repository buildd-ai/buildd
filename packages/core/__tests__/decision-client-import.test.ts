import { describe, it, expect } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * `decision-client.ts` must be importable from a plain bun process — the offline
 * benchmark (`scripts/decision-benchmark.ts`) and any caller that passes its own
 * `apiKey` never touch the database, so they must not pay for (or crash on) the
 * DB client, which imports `server-only` and throws outside Next.
 *
 * The child runs from a temp dir so no `bunfig.toml` preload stubs `server-only`
 * away: if anything on the import path loads the DB client, the import itself
 * throws and the child exits non-zero.
 */

const MODULE = resolve(import.meta.dir, '../decision-client.ts');

const CHILD = `
const mod = await import(${JSON.stringify(MODULE)});
const OK = {
  model: 'typesafe/jev-1.13-20260917',
  answers: { q: { type: 'noul', noul: 0.9 } },
  usage: { input_tokens: 10, output_tokens: 2, cost: 0.00001 },
};
const questions = { q: { type: 'noul', instructions: 'Is this a bug?' } };
const withKey = await mod.decisionCall({
  capability: 'task_category_shadow', teamId: 't', state: 'x', questions, apiKey: 'sk-or-test',
  fetcher: async () => new Response(JSON.stringify(OK), { headers: { 'content-type': 'application/json' } }),
});
// Without a key the lazy DB import is attempted; it must fail closed, not throw.
const withoutKey = await mod.decisionCall({
  capability: 'task_category_shadow', teamId: 't', state: 'x', questions,
  fetcher: async () => { throw new Error('must not fetch'); },
});
console.log(JSON.stringify({ withKey: withKey.ok, withoutKey: withoutKey.ok ? 'ok' : withoutKey.error.kind }));
`;

describe('decision-client module loading', () => {
  it('imports and serves an apiKey call without loading the DB client (no server-only stub)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'decision-import-'));
    try {
      const script = join(dir, 'child.ts');
      writeFileSync(script, CHILD);
      const env = { ...process.env };
      delete env.DATABASE_URL;
      const proc = Bun.spawn([process.execPath, script], { cwd: dir, env, stdout: 'pipe', stderr: 'pipe' });
      const timer = setTimeout(() => proc.kill(), 20_000);
      const [code, out, err] = await Promise.all([
        proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text(),
      ]);
      clearTimeout(timer);
      if (code !== 0) throw new Error(`child exited ${code}: ${err}`);
      const last = out.trim().split('\n').pop()!;
      expect(JSON.parse(last)).toEqual({ withKey: true, withoutKey: 'capability_disabled' });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
