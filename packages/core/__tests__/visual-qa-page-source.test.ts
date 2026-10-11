import { describe, it, expect } from 'bun:test';
import {
  resolveVisualQaConfig,
  resolvePreviewUrl,
  selectPageSource,
  classifyPageLoad,
  detectPreviewReadiness,
  CAPTURE_FAILURE_COMPONENTS,
  CAPTURE_STEP_COMPONENTS,
  CONFIG_ERROR_SETUP_ACTIONS,
  classifyCaptureFailure,
  classifyConfigError,
  captureErrorLine,
  parseCaptureFailure,
  formatCaptureFailureError,
  parseCaptureFailureError,
  type GitHubDeployment,
  type GitHubDeploymentStatus,
  type PreviewReads,
} from '../visual-qa-page-source';

const SHA = 'a'.repeat(40);
const PREVIEW = 'https://my-app-git-feature-team.vercel.app';
const T0 = Date.parse('2026-01-01T00:00:00Z');

function deployment(id: number, environment = 'Preview', createdAt = T0): GitHubDeployment {
  return { id, environment, sha: SHA, created_at: new Date(createdAt).toISOString() };
}
function status(state: string, url: string | null = null, createdAt = T0): GitHubDeploymentStatus {
  return { state, environment_url: url, created_at: new Date(createdAt).toISOString() };
}

/**
 * A fake clock + scripted GitHub. `script` is a list of (deployments, statuses)
 * snapshots; each poll advances to the next one and stays on the last.
 */
function scripted(snapshots: Array<{ deployments: GitHubDeployment[]; statuses: Record<number, GitHubDeploymentStatus[]> }>) {
  let clock = T0;
  let i = 0;
  let polls = 0;
  const reads: PreviewReads = {
    listDeployments: async () => {
      polls++;
      return snapshots[Math.min(i, snapshots.length - 1)].deployments;
    },
    listStatuses: async (id) => snapshots[Math.min(i, snapshots.length - 1)].statuses[id] ?? [],
  };
  return {
    reads,
    sleep: async (ms: number) => { clock += ms; i++; },
    now: () => clock,
    get polls() { return polls; },
  };
}

describe('resolveVisualQaConfig', () => {
  it('defaults to sandbox, so a workspace that never opted in keeps booting in the worker', () => {
    expect(resolveVisualQaConfig(undefined).pageSource).toBe('sandbox');
    expect(resolveVisualQaConfig({}).pageSource).toBe('sandbox');
  });

  it('keeps a valid mode and drops an unknown one back to sandbox', () => {
    expect(resolveVisualQaConfig({ pageSource: 'auto' }).pageSource).toBe('auto');
    expect(resolveVisualQaConfig({ pageSource: 'vercel-preview' }).pageSource).toBe('vercel-preview');
    expect(resolveVisualQaConfig({ pageSource: 'netlify' }).pageSource).toBe('sandbox');
  });

  it('bounds the preview wait', () => {
    expect(resolveVisualQaConfig({}).previewWaitSeconds).toBe(600);
    expect(resolveVisualQaConfig({ previewWaitSeconds: 99999 }).previewWaitSeconds).toBe(1800);
    expect(resolveVisualQaConfig({ previewWaitSeconds: -5 }).previewWaitSeconds).toBe(600);
  });

  it('design rules and reference are off unless the workspace sets them', () => {
    expect(resolveVisualQaConfig(undefined).designRules).toBeNull();
    expect(resolveVisualQaConfig({}).reference).toBeNull();
    expect(resolveVisualQaConfig({ designRules: '  docs/design/rules.md ', reference: 'https://example.com/ref' })).toMatchObject({
      designRules: 'docs/design/rules.md',
      reference: 'https://example.com/ref',
    });
  });

  it('a design-rules path must stay inside the repo', () => {
    for (const bad of ['/etc/passwd', '../secrets.md', 'docs/../../x.md', '', '   ', 42]) {
      expect(resolveVisualQaConfig({ designRules: bad }).designRules).toBeNull();
    }
    expect(resolveVisualQaConfig({ designRules: './docs/rules.md' }).designRules).toBe('docs/rules.md');
  });

  it('a reference is an artifact id or an http(s) URL, nothing else', () => {
    expect(resolveVisualQaConfig({ reference: '0f0e0d0c-0b0a-4908-8706-050403020100' }).reference).toBe('0f0e0d0c-0b0a-4908-8706-050403020100');
    expect(resolveVisualQaConfig({ reference: 'refined-ui-prototype' }).reference).toBe('refined-ui-prototype');
    for (const bad of ['javascript:alert(1)', 'has spaces in it', '', 7]) {
      expect(resolveVisualQaConfig({ reference: bad }).reference).toBeNull();
    }
  });
});

describe('resolvePreviewUrl (deployment status -> preview URL)', () => {
  const opts = { sha: SHA, environment: 'Preview', timeoutMs: 60_000, pollMs: 10_000, maxDeploymentAgeMs: 600_000 };

  it('ready: a successful Preview status gives its environment_url', async () => {
    const gh = scripted([{ deployments: [deployment(1)], statuses: { 1: [status('success', PREVIEW)] } }]);
    const r = await resolvePreviewUrl(gh.reads, { ...opts, sleep: gh.sleep, now: gh.now });
    expect(r).toEqual({ state: 'ready', url: PREVIEW, deploymentId: 1 });
  });

  it('pending then ready: polls until the status flips to success', async () => {
    const gh = scripted([
      { deployments: [deployment(1)], statuses: { 1: [status('pending')] } },
      { deployments: [deployment(1)], statuses: { 1: [status('in_progress')] } },
      { deployments: [deployment(1)], statuses: { 1: [status('success', PREVIEW), status('in_progress')] } },
    ]);
    const r = await resolvePreviewUrl(gh.reads, { ...opts, sleep: gh.sleep, now: gh.now });
    expect(r).toEqual({ state: 'ready', url: PREVIEW, deploymentId: 1 });
    expect(gh.polls).toBe(3);
  });

  it('pending past the call budget: answers pending (call again), not timeout', async () => {
    const gh = scripted([{ deployments: [deployment(1)], statuses: { 1: [status('pending')] } }]);
    const r = await resolvePreviewUrl(gh.reads, { ...opts, sleep: gh.sleep, now: gh.now });
    expect(r.state).toBe('pending');
  });

  it('timeout: a deployment still building past the bounded wait, measured from its creation', async () => {
    const gh = scripted([{ deployments: [deployment(1, 'Preview', T0 - 601_000)], statuses: { 1: [status('pending')] } }]);
    const r = await resolvePreviewUrl(gh.reads, { ...opts, sleep: gh.sleep, now: gh.now });
    expect(r.state).toBe('timeout');
    // No waiting once the wait is already spent.
    expect(gh.polls).toBe(1);
  });

  it('none: no deployment for this commit in the preview environment', async () => {
    const gh = scripted([{ deployments: [deployment(1, 'Production')], statuses: { 1: [status('success', 'https://example.com')] } }]);
    const r = await resolvePreviewUrl(gh.reads, { ...opts, sleep: gh.sleep, now: gh.now });
    expect(r.state).toBe('none');
  });

  it('failed: the newest status is failure/error', async () => {
    const gh = scripted([{ deployments: [deployment(1)], statuses: { 1: [status('error')] } }]);
    const r = await resolvePreviewUrl(gh.reads, { ...opts, sleep: gh.sleep, now: gh.now });
    expect(r.state).toBe('failed');
  });

  it('matches a Vercel custom environment name like "Preview – my-app" and prefers the newest deployment', async () => {
    const gh = scripted([{
      deployments: [deployment(2, 'Preview – my-app', T0 + 1000), deployment(1, 'Preview', T0)],
      statuses: { 1: [status('success', 'https://old.vercel.app')], 2: [status('success', PREVIEW)] },
    }]);
    const r = await resolvePreviewUrl(gh.reads, { ...opts, sleep: gh.sleep, now: gh.now });
    expect(r).toEqual({ state: 'ready', url: PREVIEW, deploymentId: 2 });
  });
});

describe('selectPageSource', () => {
  const ready = { state: 'ready' as const, url: PREVIEW, deploymentId: 1 };

  it('sandbox never looks at previews', () => {
    expect(selectPageSource('sandbox', ready)).toEqual({ ok: true, source: 'sandbox', baseUrl: null, reason: expect.any(String) });
  });

  it('vercel-preview uses a READY preview', () => {
    expect(selectPageSource('vercel-preview', ready)).toMatchObject({ ok: true, source: 'vercel-preview', baseUrl: PREVIEW });
  });

  it('vercel-preview with no READY preview is a loud error, never a fallback', () => {
    for (const r of [{ state: 'none' as const }, { state: 'timeout' as const, deploymentId: 1 }, { state: 'failed' as const, deploymentId: 1 }]) {
      const d = selectPageSource('vercel-preview', r);
      expect(d.ok).toBe(false);
      if (!d.ok) expect(d.error).toBe('preview_unavailable');
    }
  });

  it('vercel-preview still building answers pending, so the caller asks again', () => {
    expect(selectPageSource('vercel-preview', { state: 'pending', deploymentId: 1 })).toMatchObject({ ok: false, error: 'pending' });
  });

  it('auto prefers a READY preview, else falls back to sandbox and says why', () => {
    expect(selectPageSource('auto', ready)).toMatchObject({ ok: true, source: 'vercel-preview', baseUrl: PREVIEW });
    const fb = selectPageSource('auto', { state: 'none' });
    expect(fb).toMatchObject({ ok: true, source: 'sandbox', baseUrl: null });
    if (fb.ok) expect(fb.reason).toMatch(/no preview/i);
  });

  it('auto waits on a preview that is still building instead of falling back early', () => {
    expect(selectPageSource('auto', { state: 'pending', deploymentId: 1 })).toMatchObject({ ok: false, error: 'pending' });
  });
});

describe('classifyPageLoad (auth walls are config errors, not visual findings)', () => {
  const requestedUrl = `${PREVIEW}/dashboard`;

  it('a redirect to the Vercel SSO wall is protection_bypass_missing', () => {
    const r = classifyPageLoad({ requestedUrl, finalUrl: 'https://vercel.com/sso-api?url=x&nonce=y', status: 200 });
    expect(r).toMatchObject({ kind: 'config_error', error: 'protection_bypass_missing' });
  });

  it('a redirect to vercel.com/login is protection_bypass_missing', () => {
    const r = classifyPageLoad({ requestedUrl, finalUrl: 'https://vercel.com/login?next=%2Fsso-api', status: 200 });
    expect(r).toMatchObject({ kind: 'config_error', error: 'protection_bypass_missing' });
  });

  it('a 401 carrying Vercel\'s authentication page is protection_bypass_missing', () => {
    const r = classifyPageLoad({ requestedUrl, finalUrl: requestedUrl, status: 401, bodyText: 'Authentication Required — Vercel' });
    expect(r).toMatchObject({ kind: 'config_error', error: 'protection_bypass_missing' });
  });

  it('a same-origin landing on the app sign-in page is app_auth_not_configured', () => {
    for (const path of ['/login', '/api/auth/signin?callbackUrl=%2Fdashboard', '/sign-in']) {
      const r = classifyPageLoad({ requestedUrl, finalUrl: `${PREVIEW}${path}`, status: 200 });
      expect(r).toMatchObject({ kind: 'config_error', error: 'app_auth_not_configured' });
    }
  });

  it('honours workspace sign-in paths', () => {
    const r = classifyPageLoad({ requestedUrl, finalUrl: `${PREVIEW}/welcome`, status: 200, signInPaths: ['/welcome'] });
    expect(r).toMatchObject({ kind: 'config_error', error: 'app_auth_not_configured' });
  });

  it('asking for the sign-in page itself is a normal page', () => {
    expect(classifyPageLoad({ requestedUrl: `${PREVIEW}/login`, finalUrl: `${PREVIEW}/login`, status: 200 }).kind).toBe('ok');
  });

  it('a normal page, and a path that merely starts with a sign-in word, are ok', () => {
    expect(classifyPageLoad({ requestedUrl, finalUrl: requestedUrl, status: 200 }).kind).toBe('ok');
    expect(classifyPageLoad({ requestedUrl, finalUrl: `${PREVIEW}/authors`, status: 200 }).kind).toBe('ok');
  });

  it('a plain 404 or 500 is left to the judge, not called an auth wall', () => {
    expect(classifyPageLoad({ requestedUrl, finalUrl: requestedUrl, status: 500, bodyText: 'Internal error' }).kind).toBe('ok');
  });
});

describe('detectPreviewReadiness', () => {
  const base = {
    recentDeploymentEnvironments: [] as string[],
    secretLabels: [] as string[],
    envMapping: {} as Record<string, string>,
  };

  it('no previews: recommends sandbox and says why', () => {
    const r = detectPreviewReadiness(base);
    expect(r.previewsDetected).toBe(false);
    expect(r.recommendedPageSource).toBe('sandbox');
    expect(r.recommendation.join(' ')).toMatch(/no preview deployments/i);
  });

  it('protected previews with nothing configured: names both setup steps', () => {
    const r = detectPreviewReadiness({ ...base, recentDeploymentEnvironments: ['Preview', 'Production'], previewProbe: { status: 302, location: 'https://vercel.com/sso-api?url=x' } });
    expect(r.previewsDetected).toBe(true);
    expect(r.previewProtected).toBe(true);
    expect(r.protectionBypassConfigured).toBe(false);
    expect(r.appAuthStrategy).toBe('none');
    const text = r.recommendation.join('\n');
    expect(text).toContain('VERCEL_AUTOMATION_BYPASS_SECRET');
    expect(text).toMatch(/preview-only auth bypass/i);
    expect(r.recommendedPageSource).toBe('sandbox');
  });

  it('a bypass mapped to a secret that exists counts as configured; a dangling label does not', () => {
    const mapped = { ...base, recentDeploymentEnvironments: ['Preview'], envMapping: { VERCEL_AUTOMATION_BYPASS_SECRET: 'vercel-bypass' } };
    expect(detectPreviewReadiness({ ...mapped, secretLabels: ['vercel-bypass'] }).protectionBypassConfigured).toBe(true);
    expect(detectPreviewReadiness(mapped).protectionBypassConfigured).toBe(false);
  });

  it('prefers the project-owned preview auth bypass over a stored session', () => {
    const r = detectPreviewReadiness({
      ...base,
      recentDeploymentEnvironments: ['Preview'],
      envMapping: { VERCEL_AUTOMATION_BYPASS_SECRET: 'b', VISUAL_QA_STORAGE_STATE: 's' },
      secretLabels: ['b', 's'],
      repoEnvNames: ['PREVIEW_AUTH_BYPASS'],
    });
    expect(r.appAuthStrategy).toBe('preview-bypass-env');
    expect(r.recommendedPageSource).toBe('auto');
  });

  it('a stored session is the fallback strategy', () => {
    const r = detectPreviewReadiness({
      ...base, recentDeploymentEnvironments: ['Preview'],
      envMapping: { VERCEL_AUTOMATION_BYPASS_SECRET: 'b', VISUAL_QA_STORAGE_STATE: 's' }, secretLabels: ['b', 's'],
    });
    expect(r.appAuthStrategy).toBe('storage-state');
    expect(r.recommendedPageSource).toBe('auto');
  });

  it('an unprotected preview of an app with no login needs neither', () => {
    const r = detectPreviewReadiness({ ...base, recentDeploymentEnvironments: ['Preview'], previewProbe: { status: 200 }, appHasLogin: false });
    expect(r.previewProtected).toBe(false);
    expect(r.appAuthStrategy).toBe('not-needed');
    expect(r.recommendedPageSource).toBe('auto');
  });
});

// docs/specs/failure-incident-recovery.md §16.2, §16.3, §16.5: every capture
// failure is typed into a closed component set before anyone is asked.
describe('classifyCaptureFailure', () => {
  it('has exactly the closed v1 component set', () => {
    expect([...CAPTURE_FAILURE_COMPONENTS].sort()).toEqual([
      'visual_qa.boot', 'visual_qa.browser', 'visual_qa.clone', 'visual_qa.guard', 'visual_qa.migrate', 'visual_qa.scrub',
    ]);
    for (const c of Object.values(CAPTURE_STEP_COMPONENTS)) expect(CAPTURE_FAILURE_COMPONENTS).toContain(c);
  });

  it.each([
    ['Create Neon prod-clone branch', 'visual_qa.clone'],
    ['Run migrations', 'visual_qa.migrate'],
    ['Scrub prod clone to placeholders', 'visual_qa.scrub'],
    ['Guard scrubbed clone', 'visual_qa.guard'],
    ['Start app', 'visual_qa.boot'],
    ['Install Playwright + Chromium', 'visual_qa.browser'],
  ])('a failed "%s" step is %s, owned by infrastructure', (step, component) => {
    const f = classifyCaptureFailure({ step, error: 'boom' });
    expect(f).toMatchObject({ ownership: 'infrastructure', component, step });
    expect(f.errorSignature).toMatch(/^visual-qa:/);
  });

  it('an unknown step is explicit inconclusive, never defaulted to a person', () => {
    const f = classifyCaptureFailure({ step: 'Install dependencies', error: 'bun install failed' });
    expect(f).toMatchObject({ ownership: 'inconclusive', component: null, step: 'Install dependencies' });
  });

  it('an explicit component wins over the step map (capture.ts knows boot from browser)', () => {
    const f = classifyCaptureFailure({ step: 'Capture screenshots and a11y snapshots', component: 'visual_qa.boot', error: 'document response was HTTP 500' });
    expect(f).toMatchObject({ ownership: 'infrastructure', component: 'visual_qa.boot' });
  });

  it('the same scrub statement failing on two runs gives one signature (one incident, I-10)', () => {
    const a = classifyCaptureFailure({ step: 'Scrub prod clone to placeholders', error: 'psql:scripts/qa/scrub-pii.sql:412: ERROR:  artifact_revisions rows are immutable\nCONTEXT: PL/pgSQL function x() line 3' });
    const b = classifyCaptureFailure({ step: 'Scrub prod clone to placeholders', error: 'psql:/home/runner/work/buildd/.qa-harness/scripts/qa/scrub-pii.sql:530: ERROR:  artifact_revisions rows are immutable' });
    expect(a.errorSignature).toBe(b.errorSignature);
    expect(a.error).toBe('artifact_revisions rows are immutable');
    const other = classifyCaptureFailure({ step: 'Scrub prod clone to placeholders', error: 'ERROR: column "x" does not exist' });
    expect(other.errorSignature).not.toBe(a.errorSignature);
  });

  it('no error text still yields a stable signature', () => {
    const f = classifyCaptureFailure({ step: 'Start app', error: null });
    expect(f.errorSignature).toMatch(/^visual-qa:/);
    expect(f.errorSignature).toBe(classifyCaptureFailure({ step: 'Start app', error: '' }).errorSignature);
  });
});

describe('captureErrorLine', () => {
  it('picks the error line, drops the psql location and annotation prefixes', () => {
    expect(captureErrorLine('NOTICE: x\npsql:scripts/qa/scrub-pii.sql:9: ERROR:  boom here\nDETAIL: Key (id)=(1)')).toBe('boom here');
    expect(captureErrorLine('::error::Failed to create Neon branch: {"code":"x"}')).toBe('Failed to create Neon branch: {"code":"x"}');
    expect(captureErrorLine('applying 0001\nMigration failed: relation "t" already exists')).toBe('Migration failed: relation "t" already exists');
    expect(captureErrorLine('just text')).toBe('just text');
    expect(captureErrorLine(null)).toBe('');
  });
});

describe('classifyConfigError (the preview auth walls stay a person\'s setup, AC-17)', () => {
  it.each(['protection_bypass_missing', 'app_auth_not_configured'] as const)('%s is owned by a person, with typed setup actions, never retry or cancel', (error) => {
    const f = classifyConfigError(error, 'Capture screenshots and a11y snapshots');
    expect(f).toMatchObject({ ownership: 'person', component: null, configError: error });
    expect(f.errorSignature).toMatch(/^visual-qa:/);
    const actions = CONFIG_ERROR_SETUP_ACTIONS[error];
    expect(actions.length).toBeGreaterThan(0);
    for (const a of actions) expect(a.label).not.toMatch(/retry|cancel|sync dev|capture dev/i);
  });
});

describe('parseCaptureFailure', () => {
  it('round-trips a classified failure with run facts', () => {
    const f = { ...classifyCaptureFailure({ step: 'Guard scrubbed clone', error: 'x' }), runId: '123', ref: 'mission/a', headSha: 'b'.repeat(40) };
    expect(parseCaptureFailure(JSON.parse(JSON.stringify(f)))).toEqual(f);
  });

  it('rejects anything outside the closed set', () => {
    expect(parseCaptureFailure(null)).toBeNull();
    expect(parseCaptureFailure({ ownership: 'infrastructure', component: 'visual_qa.db', step: 's', errorSignature: 'visual-qa:x' })).toBeNull();
    expect(parseCaptureFailure({ ownership: 'person', component: null, step: 's', errorSignature: 'visual-qa:x', configError: 'nope' })).toBeNull();
    expect(parseCaptureFailure({ ownership: 'infrastructure', component: 'visual_qa.scrub', step: 's' })).toBeNull();
  });
});

// A failed complete_task persists `error`, not `structuredOutput`, so the
// typed failure rides in the error text and is read back with the parser.
describe('formatCaptureFailureError / parseCaptureFailureError', () => {
  it('round-trips through the one-line error the auditor reports', () => {
    const f = { ...classifyCaptureFailure({ step: 'Scrub prod clone to placeholders', error: 'ERROR: x is immutable' }), runId: '9', ref: 'mission/a', headSha: 'd'.repeat(40) };
    const line = formatCaptureFailureError(f);
    expect(line).toStartWith('capture_failure: visual_qa.scrub at Scrub prod clone to placeholders {');
    expect(line).not.toContain('\n');
    expect(parseCaptureFailureError(line)).toEqual(f);
  });

  it('reads what an agent writes by hand from jq -c', () => {
    const f = classifyCaptureFailure({ step: 'Start app', error: 'App failed to start after 120s' });
    expect(parseCaptureFailureError(`capture_failure: visual_qa.boot at Start app ${JSON.stringify(f)}`)).toEqual(f);
  });

  it('anything else is null, never a guess', () => {
    expect(parseCaptureFailureError('App did not boot')).toBeNull();
    expect(parseCaptureFailureError('capture_failure: visual_qa.scrub at x {not json')).toBeNull();
    expect(parseCaptureFailureError(null)).toBeNull();
  });
});
