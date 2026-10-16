import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';

for (const failure of ['prerequisite', 'measurement'] as const) {
  test(`capture exits 4 for a failed ${failure}, preserving screenshots and metadata`, async () => {
    const output = mkdtempSync(join(import.meta.dir, '.capture-test-'));
    // Exercise the capture CLI without requiring a browser install in unit CI.
    // The step engine uses the same locator failures Playwright returns.
    const preload = join(output, 'browser.ts');
    writeFileSync(preload, `
      import { mock } from 'bun:test';
      import { writeFileSync } from 'fs';
      let url = '';
      const locator = { first() { return this; }, count: async () => 0,
        waitFor: async () => { if (process.env.CAPTURE_FAILURE === 'prerequisite') throw new Error('selector timeout'); },
        evaluate: async () => { throw new Error('measurement failed'); } };
      const page = { on() {}, goto: async (next) => { url = next; return { status: () => 200 }; },
        url: () => url, route: async () => {}, unroute: async () => {},
        locator: () => locator, getByTestId: () => locator,
        evaluate: async () => {}, screenshot: async ({path}) => writeFileSync(path, 'shot'),
        ariaSnapshot: async () => 'Fixture' };
      mock.module('playwright', () => ({ chromium: { launch: async () => ({
        newContext: async () => ({ newPage: async () => page }), close: async () => {}, version: () => 'mock'
      }) } }));
    `);
    try {
      const child = Bun.spawn(['bun', '--preload', preload, 'scripts/qa/capture.ts'], {
        cwd: join(import.meta.dir, '../..'),
        env: { ...process.env, BUILDD_BROWSER_PROVIDER: 'local', QA_NO_LOGIN: '1', CAPTURE_FAILURE: failure, QA_BASE_URL: 'http://localhost:3000', QA_OUTPUT: output, QA_VIEWPORT: '360x780', QA_PLAN: JSON.stringify([{route:'/fixture', states:[{ key:'layout', steps:[{ action:'waitFor', selector: failure === 'prerequisite' ? 'testid:missing' : 'testid:scenario', timeoutMs:50 }, { action:'assertLayout' }] }]}]) },
        stdout:'pipe', stderr:'pipe',
      });
      const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect({ exitCode, output: exitCode === 4 ? '' : stdout + stderr }).toEqual({ exitCode:4, output:'' });
      const captures = JSON.parse(readFileSync(join(output, 'captures.json'), 'utf8'));
      const state = captures.find((c: any) => c.state === 'layout');
      expect(state.stepFailed).toMatchObject({ assertion:true, index: failure === 'prerequisite' ? 0 : 1 });
      expect(existsSync(join(output, 'screenshots', `${state.id}.png`))).toBe(true);
    } finally { rmSync(output, {recursive:true, force:true}); }
  }, 30_000);
}

// docs/specs/failure-incident-recovery.md §16.5: capture.ts types its own
// failures into the manifest, so the auditor reports them instead of asking.
test('a browser that will not launch is a typed visual_qa.browser failure', async () => {
  const output = mkdtempSync(join(import.meta.dir, '.capture-test-'));
  try {
    const child = Bun.spawn(['bun', 'scripts/qa/capture.ts'], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, BUILDD_BROWSER_PROVIDER: 'none', QA_OUTPUT: output, QA_ROUTES: '/fixture' },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).toBe(1);
    const f = JSON.parse(readFileSync(join(output, 'capture-failure.json'), 'utf8'));
    expect(f).toMatchObject({ ownership: 'infrastructure', component: 'visual_qa.browser', step: 'Capture screenshots and a11y snapshots' });
    expect(f.errorSignature).toMatch(/^visual-qa:provider_missing/);
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 30_000);

test('a 5xx document is a typed visual_qa.boot failure, beside the shots', async () => {
  const output = mkdtempSync(join(import.meta.dir, '.capture-test-'));
  const preload = join(output, 'browser.ts');
  writeFileSync(preload, `
    import { mock } from 'bun:test';
    import { writeFileSync } from 'fs';
    let url = '';
    const locator = { first() { return this; }, count: async () => 0 };
    const page = { on() {}, goto: async (next) => { url = next; return { status: () => 500 }; },
      url: () => url, locator: () => locator, evaluate: async () => {},
      screenshot: async ({path}) => writeFileSync(path, 'shot'), ariaSnapshot: async () => 'Fixture' };
    mock.module('playwright', () => ({ chromium: { launch: async () => ({
      newContext: async () => ({ newPage: async () => page }), close: async () => {}, version: () => 'mock'
    }) } }));
  `);
  try {
    const child = Bun.spawn(['bun', '--preload', preload, 'scripts/qa/capture.ts'], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, BUILDD_BROWSER_PROVIDER: 'local', QA_NO_LOGIN: '1', QA_OUTPUT: output, QA_ROUTES: '/fixture' },
      stdout: 'pipe', stderr: 'pipe',
    });
    expect(await child.exited).toBe(5);
    expect(existsSync(join(output, 'captures.json'))).toBe(true);
    const f = JSON.parse(readFileSync(join(output, 'capture-failure.json'), 'utf8'));
    expect(f).toMatchObject({ ownership: 'infrastructure', component: 'visual_qa.boot' });
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 30_000);
