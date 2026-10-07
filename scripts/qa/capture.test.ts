import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'fs';
import { join } from 'path';

for (const failure of ['prerequisite', 'measurement'] as const) {
  test(`capture exits 4 for a failed ${failure}, preserving screenshots and metadata`, async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response(`<html><body><main data-testid="scenario">Fixture</main>${failure === 'measurement' ? '<script>Object.defineProperty(window, "innerWidth", { get() { throw new Error("measurement failed") } })</script>' : ''}</body></html>`, { headers: { 'Content-Type': 'text/html' } }) });
    const output = mkdtempSync(join(import.meta.dir, '.capture-test-'));
    try {
      const child = Bun.spawn(['bun', 'scripts/qa/capture.ts'], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, QA_BASE_URL: `http://localhost:${server.port}`, QA_OUTPUT: output, QA_VIEWPORT: '360x780', QA_PLAN: JSON.stringify([{route:'/fixture', states:[{ key:'layout', steps:[{ action:'waitFor', selector: failure === 'prerequisite' ? 'testid:missing' : 'testid:scenario', timeoutMs:50 }, { action:'assertLayout' }] }]}]) },
        stdout:'pipe', stderr:'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exitCode, output: exitCode === 4 ? '' : stdout + stderr }).toEqual({ exitCode:4, output:'' });
      const captures = JSON.parse(readFileSync(join(output, 'captures.json'), 'utf8'));
      const state = captures.find((c: any) => c.state === 'layout');
      expect(state.stepFailed).toMatchObject({ assertion:true, index: failure === 'prerequisite' ? 0 : 1 });
      expect(existsSync(join(output, 'screenshots', `${state.id}.png`))).toBe(true);
    } finally { server.stop(true); rmSync(output, {recursive:true, force:true}); }
  }, 30_000);
}
