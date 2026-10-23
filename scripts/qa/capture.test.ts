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

// scripts/qa/surface-evidence.ts: a plan surface becomes evidence beside the
// shot, with facts from QA_SURFACE_FACTS; without a capture SHA it says why not.
for (const sha of ['b'.repeat(40), ''] as const) {
  test(`a plan surface ${sha ? 'is written as surface evidence' : 'without QA_CAPTURE_SHA records why there is none'}`, async () => {
    const output = mkdtempSync(join(import.meta.dir, '.capture-test-'));
    const preload = join(output, 'browser.ts');
    writeFileSync(preload, `
      import { mock } from 'bun:test';
      import { writeFileSync } from 'fs';
      let url = '';
      const locator = { first() { return this; }, count: async () => 0 };
      const raw = { found: 1, blocks: [{ id: 'status', role: 'status', text: 'Closed', collapsed: false, nested: false }],
        actions: [{ id: 'merge', operation: 'merge_pr', prominence: 'primary', inMenu: false, label: 'Merge', enabled: true, collapsed: false }] };
      const page = { on() {}, goto: async (next) => { url = next; return { status: () => 200 }; },
        url: () => url, locator: () => locator, evaluate: async (_fn, arg) => (arg === 'task-pr-card' ? raw : undefined),
        screenshot: async ({path}) => writeFileSync(path, 'shot'), ariaSnapshot: async () => 'Fixture' };
      mock.module('playwright', () => ({ chromium: { launch: async () => ({
        newContext: async () => ({ newPage: async () => page }), close: async () => {}, version: () => 'mock'
      }) } }));
    `);
    try {
      const child = Bun.spawn(['bun', '--preload', preload, 'scripts/qa/capture.ts'], {
        cwd: join(import.meta.dir, '../..'),
        env: {
          ...process.env, BUILDD_BROWSER_PROVIDER: 'local', QA_NO_LOGIN: '1', QA_OUTPUT: output, QA_VIEWPORT: 'mobile', QA_CAPTURE_SHA: sha,
          QA_PLAN: JSON.stringify([{ route: '/fixture', surface: { id: 'task-pr-card', scenario: 'closed-pr' } }]),
          QA_SURFACE_FACTS: JSON.stringify({ factVersion: 'seed@1', scenarios: { 'closed-pr': { prState: 'closed' } } }),
          QA_SURFACE_COLLECTOR: 'visual_auditor',
        },
        stdout: 'pipe', stderr: 'pipe',
      });
      expect(await child.exited).toBe(0);
      const [shot] = JSON.parse(readFileSync(join(output, 'captures.json'), 'utf8'));
      if (sha) {
        expect(shot.surface).toEqual({ id: 'task-pr-card', scenarioId: 'closed-pr', file: 'surfaces/fixture.json' });
        const e = JSON.parse(readFileSync(join(output, 'surfaces', 'fixture.json'), 'utf8'));
        expect(e).toMatchObject({
          subject: { commitSha: sha, route: '/fixture', scenarioId: 'closed-pr', viewport: 'mobile' },
          facts: { prState: 'closed' }, provenance: { collector: 'visual_auditor', factVersion: 'seed@1' },
          visible: { actions: [{ operation: 'merge_pr', enabled: true }] },
        });
      } else {
        expect(shot.surface).toMatchObject({ id: 'task-pr-card', missing: expect.stringContaining('capture_sha_unset') });
        expect(existsSync(join(output, 'surfaces', 'fixture.json'))).toBe(false);
      }
    } finally { rmSync(output, { recursive: true, force: true }); }
  }, 30_000);
}

// Design vs built (scripts/qa/design-capture.ts): with QA_DESIGN, the page is
// shot in the design's theme, each capture records its viewport, and the
// design screens render in the same browser but a context of their own.
test('QA_DESIGN: page in the design theme, then the design screens in a clean context, paired by route', async () => {
  const output = mkdtempSync(join(import.meta.dir, '.capture-test-'));
  const preload = join(output, 'browser.ts');
  const design = join(output, 'design.html');
  writeFileSync(design, '<section data-screen="phone-mission" data-viewport="390x844" data-theme="light"></section>');
  writeFileSync(preload, `
    import { mock } from 'bun:test';
    import { writeFileSync, appendFileSync } from 'fs';
    const log = (o) => appendFileSync(${JSON.stringify(join(output, 'contexts.jsonl'))}, JSON.stringify(o) + '\\n');
    let url = '';
    const locator = { first() { return this; }, count: async () => 1, isVisible: async () => true,
      screenshot: async ({ path }) => writeFileSync(path, 'shot') };
    const page = { on() {}, goto: async (next) => { url = next; return { status: () => 200 }; },
      url: () => url, locator: (sel) => sel === 'nextjs-portal' ? { count: async () => 0 } : locator, evaluate: async () => {}, waitForTimeout: async () => {}, setContent: async () => {},
      screenshot: async ({path}) => writeFileSync(path, 'shot'), ariaSnapshot: async () => 'Fixture' };
    mock.module('playwright', () => ({ chromium: { launch: async () => ({
      newContext: async (o) => { log({ storageState: o.storageState ?? null, colorScheme: o.colorScheme ?? null, width: o.viewport?.width ?? null });
        return { newPage: async () => page, addInitScript: async () => {}, addCookies: async () => {}, route: async () => {}, close: async () => {} }; },
      close: async () => {}, version: () => 'mock'
    }) } }));
  `);
  try {
    const child = Bun.spawn(['bun', '--preload', preload, 'scripts/qa/capture.ts'], {
      cwd: join(import.meta.dir, '../..'),
      env: { ...process.env, BUILDD_BROWSER_PROVIDER: 'local', QA_NO_LOGIN: '1', QA_OUTPUT: output, QA_ROUTES: '/app/missions/m1', QA_VIEWPORT: 'mobile', QA_THEME: '',
        QA_DESIGN: JSON.stringify({ design: { file: design, artifactId: 'art-1', revision: 1 }, criteria: [{ id: 'AC-4', screens: ['phone-mission'] }] }) },
      stdout: 'pipe', stderr: 'pipe',
    });
    const [exitCode, out, err] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ exitCode, log: exitCode === 0 ? '' : out + err }).toEqual({ exitCode: 0, log: '' });
    const captures = JSON.parse(readFileSync(join(output, 'captures.json'), 'utf8'));
    expect(captures[0]).toMatchObject({ theme: 'light', viewport: { width: 390, height: 844 } });
    const contexts = readFileSync(join(output, 'contexts.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    // The page's context, then the design screen's, then the side-by-side's: never the same one.
    expect(contexts.length).toBe(3);
    expect(contexts[1]).toEqual({ storageState: null, colorScheme: 'light', width: 390 });
    const result = JSON.parse(readFileSync(join(output, 'design-captures.json'), 'utf8'));
    expect(result.pairs.map((p: any) => [p.captureId, p.screen, p.sideBySide])).toEqual([['app-missions-m1', 'phone-mission', 'side-by-side/app-missions-m1--phone-mission.png']]);
    expect(existsSync(join(output, 'designs', 'phone-mission.png'))).toBe(true);
  } finally { rmSync(output, { recursive: true, force: true }); }
}, 30_000);
