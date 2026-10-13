/**
 * Where the visual auditor's pages come from (docs/design/visual-qa-auditor.md,
 * "Page source"): the app booted in the worker sandbox, or the Vercel preview
 * deployed for the commit.
 *
 * Pure. GitHub reads are injected (`PreviewReads`), so the web route supplies
 * the workspace's GitHub App token and tests supply a script. Nothing here
 * sees a secret value: protection bypass and stored sessions reach the worker
 * as env vars through `gitConfig.envMapping`, and this module only checks
 * whether they are mapped.
 */

import { normalizeErrorSignature } from './error-signature';
import { toFrictionSignature } from './failure-friction-signature';

export type PageSourceMode = 'sandbox' | 'vercel-preview' | 'auto';
export type PageSource = 'sandbox' | 'vercel-preview';

export const PAGE_SOURCE_MODES: readonly PageSourceMode[] = ['sandbox', 'vercel-preview', 'auto'];

/** Env var capture.ts sends as `x-vercel-protection-bypass`. */
export const VERCEL_BYPASS_ENV = 'VERCEL_AUTOMATION_BYPASS_SECRET';
/** Env var holding a Playwright storageState JSON for the app's own login. */
export const STORAGE_STATE_ENV = 'VISUAL_QA_STORAGE_STATE';
/** Default name of the project-owned, preview-only auth bypass env var. */
export const DEFAULT_PREVIEW_AUTH_BYPASS_ENV = 'PREVIEW_AUTH_BYPASS';

export const DEFAULT_SIGN_IN_PATHS: readonly string[] = ['/login', '/signin', '/sign-in', '/auth', '/api/auth/signin'];

const DEFAULT_PREVIEW_WAIT_SECONDS = 600;
const MAX_PREVIEW_WAIT_SECONDS = 1800;

/** `gitConfig.visualQa`, as stored. Every field optional. */
export interface VisualQaConfig {
  pageSource?: PageSourceMode;
  /** GitHub deployment environment Vercel posts previews under. Default `Preview`. */
  previewEnvironment?: string;
  /** How long a preview may take to become READY, from the deployment's creation. */
  previewWaitSeconds?: number;
  /** App sign-in paths; landing on one uninvited is `app_auth_not_configured`. */
  signInPaths?: string[];
  /** The project's own preview-only auth bypass env var name. */
  previewAuthBypassEnv?: string;
  /**
   * A repo path to the workspace's design rules. When set, the surface audit
   * checks every shot against it. Off when absent.
   */
  designRules?: string;
  /** An artifact id or http(s) URL of an approved design reference that findings compare against. Off when absent. */
  reference?: string;
}

export interface ResolvedVisualQaConfig {
  pageSource: PageSourceMode;
  previewEnvironment: string;
  previewWaitSeconds: number;
  signInPaths: string[];
  previewAuthBypassEnv: string;
  designRules: string | null;
  reference: string | null;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Defaults for anything missing or malformed. An unknown mode is `sandbox`, today's behaviour. */
export function resolveVisualQaConfig(raw: unknown): ResolvedVisualQaConfig {
  const c = isRecord(raw) ? raw : {};
  const mode = PAGE_SOURCE_MODES.includes(c.pageSource as PageSourceMode) ? (c.pageSource as PageSourceMode) : 'sandbox';
  const wait = typeof c.previewWaitSeconds === 'number' && Number.isFinite(c.previewWaitSeconds) && c.previewWaitSeconds > 0
    ? Math.min(Math.round(c.previewWaitSeconds), MAX_PREVIEW_WAIT_SECONDS)
    : DEFAULT_PREVIEW_WAIT_SECONDS;
  const signIn = Array.isArray(c.signInPaths)
    ? c.signInPaths.filter((p): p is string => typeof p === 'string' && p.startsWith('/'))
    : [];
  return {
    pageSource: mode,
    previewEnvironment: typeof c.previewEnvironment === 'string' && c.previewEnvironment.trim() ? c.previewEnvironment.trim() : 'Preview',
    previewWaitSeconds: wait,
    signInPaths: signIn.length > 0 ? signIn : [...DEFAULT_SIGN_IN_PATHS],
    previewAuthBypassEnv: typeof c.previewAuthBypassEnv === 'string' && /^[A-Z_][A-Z0-9_]*$/.test(c.previewAuthBypassEnv)
      ? c.previewAuthBypassEnv
      : DEFAULT_PREVIEW_AUTH_BYPASS_ENV,
    designRules: repoPath(c.designRules),
    reference: designReference(c.reference),
  };
}

/** A path inside the repo, `./` dropped. Absolute or `..` paths are null: the auditor reads it from its checkout. */
function repoPath(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const p = v.trim().replace(/^(\.\/)+/, '');
  if (!p || p.length > 300 || p.startsWith('/') || p.split('/').includes('..')) return null;
  return p;
}

/** An http(s) URL, or an artifact id or key (no spaces, no scheme). */
function designReference(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const r = v.trim();
  if (!r || r.length > 500) return null;
  if (/^https?:\/\/\S+$/i.test(r)) return r;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(r) ? r : null;
}

// ---------------------------------------------------------------------------
// Deployment status -> preview URL
// ---------------------------------------------------------------------------

/** The fields read from `GET /repos/{o}/{r}/deployments`. */
export interface GitHubDeployment {
  id: number;
  environment: string;
  sha?: string;
  created_at: string;
}

/** The fields read from `GET /repos/{o}/{r}/deployments/{id}/statuses` (newest first, as GitHub returns them). */
export interface GitHubDeploymentStatus {
  state: string;
  environment_url?: string | null;
  created_at: string;
}

export interface PreviewReads {
  listDeployments(sha: string): Promise<GitHubDeployment[]>;
  listStatuses(deploymentId: number): Promise<GitHubDeploymentStatus[]>;
}

export type PreviewResolution =
  | { state: 'ready'; url: string; deploymentId: number }
  | { state: 'pending'; deploymentId: number }
  | { state: 'timeout'; deploymentId: number }
  | { state: 'failed'; deploymentId: number }
  | { state: 'none' }
  | { state: 'unreadable'; reason: string };

/**
 * `Preview` matches `Preview` and Vercel's per-project custom names
 * (`Preview – my-app`), case-insensitively. Never `Production`.
 */
export function matchesPreviewEnvironment(environment: string, wanted: string): boolean {
  const e = environment.trim().toLowerCase();
  const w = wanted.trim().toLowerCase();
  return e === w || e.startsWith(`${w} `);
}

const FAILED_STATES = new Set(['failure', 'error']);

async function probePreview(
  reads: PreviewReads,
  sha: string,
  environment: string,
  ageMs: (createdAt: string) => number,
  maxDeploymentAgeMs: number,
): Promise<PreviewResolution> {
  const deployments = (await reads.listDeployments(sha))
    .filter(d => matchesPreviewEnvironment(d.environment, environment) && (!d.sha || d.sha === sha))
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const newest = deployments[0];
  if (!newest) return { state: 'none' };

  const statuses = await reads.listStatuses(newest.id);
  const latest = statuses[0];
  // A newer deployment in the same environment marks this one `inactive`;
  // the preview URL it succeeded with still serves this commit.
  const succeeded = statuses.find(s => s.state === 'success' && s.environment_url);
  if (succeeded && (latest?.state === 'success' || latest?.state === 'inactive')) {
    return { state: 'ready', url: succeeded.environment_url!.replace(/\/+$/, ''), deploymentId: newest.id };
  }
  if (latest && FAILED_STATES.has(latest.state)) return { state: 'failed', deploymentId: newest.id };
  if (ageMs(newest.created_at) > maxDeploymentAgeMs) return { state: 'timeout', deploymentId: newest.id };
  return { state: 'pending', deploymentId: newest.id };
}

/**
 * Resolve the preview URL for `sha`. Polls a still-building deployment every
 * `pollMs` for at most `timeoutMs` in this call (a long-poll; `pending` means
 * call again). The overall wait is bounded by `maxDeploymentAgeMs` from the
 * deployment's own creation, so it holds across calls: past it, `timeout`.
 * No deployment in the preview environment is `none`, at once.
 */
export async function resolvePreviewUrl(
  reads: PreviewReads,
  opts: {
    sha: string;
    environment: string;
    timeoutMs: number;
    pollMs: number;
    maxDeploymentAgeMs: number;
    sleep?: (ms: number) => Promise<void>;
    now?: () => number;
  },
): Promise<PreviewResolution> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>(r => setTimeout(r, ms)));
  const started = now();
  const ageMs = (createdAt: string) => now() - Date.parse(createdAt);
  for (;;) {
    const r = await probePreview(reads, opts.sha, opts.environment, ageMs, opts.maxDeploymentAgeMs);
    if (r.state !== 'pending') return r;
    if (now() - started + opts.pollMs > opts.timeoutMs) return r;
    await sleep(opts.pollMs);
  }
}

// ---------------------------------------------------------------------------
// Source selection
// ---------------------------------------------------------------------------

export type PageSourceDecision =
  | { ok: true; source: PageSource; baseUrl: string | null; reason: string }
  | { ok: false; error: 'pending' | 'preview_unavailable'; reason: string };

function unavailableReason(r: PreviewResolution | null): string {
  if (!r) return 'the preview was not looked up';
  switch (r.state) {
    case 'none': return 'no preview deployment for this commit';
    case 'timeout': return 'the preview did not become READY within the wait';
    case 'failed': return 'the preview deployment failed';
    case 'unreadable': return `could not read the commit's deployments: ${r.reason}`;
    default: return 'the preview is not ready';
  }
}

/**
 * `sandbox` never looks at previews. `vercel-preview` uses a READY preview and
 * is a loud `preview_unavailable` otherwise, never a silent fallback. `auto`
 * uses a READY preview, waits on one still building, and otherwise falls back
 * to the sandbox with the reason recorded.
 */
export function selectPageSource(mode: PageSourceMode, preview: PreviewResolution | null): PageSourceDecision {
  if (mode === 'sandbox') {
    return { ok: true, source: 'sandbox', baseUrl: null, reason: 'the workspace page source is sandbox' };
  }
  if (preview?.state === 'ready') {
    return { ok: true, source: 'vercel-preview', baseUrl: preview.url, reason: `preview deployment ${preview.deploymentId} is READY` };
  }
  if (preview?.state === 'pending') {
    return { ok: false, error: 'pending', reason: 'the preview is still building; ask again' };
  }
  if (mode === 'vercel-preview') {
    return { ok: false, error: 'preview_unavailable', reason: unavailableReason(preview) };
  }
  return { ok: true, source: 'sandbox', baseUrl: null, reason: `fell back to sandbox: ${unavailableReason(preview)}` };
}

// ---------------------------------------------------------------------------
// Auth walls
// ---------------------------------------------------------------------------

export type CaptureConfigError = 'protection_bypass_missing' | 'app_auth_not_configured';

export type PageLoadClass =
  | { kind: 'ok' }
  | { kind: 'config_error'; error: CaptureConfigError; message: string };

export const CONFIG_ERROR_MESSAGES: Record<CaptureConfigError, string> = {
  protection_bypass_missing:
    `Vercel deployment protection blocked the preview (protection bypass missing). Create a Protection Bypass for Automation secret in the Vercel project, store it with manage_secrets (purpose role_env_secret) and map it in gitConfig.envMapping as ${VERCEL_BYPASS_ENV}.`,
  app_auth_not_configured:
    `The preview redirected to the app's sign-in page (app auth not configured). Add a preview-only auth bypass env var to the project's Vercel Preview environment, or store a Playwright storageState as a secret mapped as ${STORAGE_STATE_ENV}.`,
};

function safeUrl(u: string): URL | null {
  try { return new URL(u); } catch { return null; }
}

function isVercelWall(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  if (host !== 'vercel.com' && !host.endsWith('.vercel.com')) return false;
  return url.pathname.startsWith('/login') || url.pathname.startsWith('/sso-api') || url.pathname.startsWith('/sso');
}

function onSignInPath(pathname: string, signInPaths: readonly string[]): boolean {
  const p = pathname.replace(/\/+$/, '') || '/';
  return signInPaths.some(s => {
    const base = s.replace(/\/+$/, '') || '/';
    return p === base || p.startsWith(`${base}/`);
  });
}

/**
 * Classify one navigation. An auth wall is a config error, never a visual
 * finding: the auditor asks the owner to fix the config instead of judging a
 * login page. Anything else (including a 404 or 500) is left to the judge.
 */
export function classifyPageLoad(input: {
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  bodyText?: string | null;
  signInPaths?: readonly string[];
}): PageLoadClass {
  const requested = safeUrl(input.requestedUrl);
  const final = safeUrl(input.finalUrl);
  const wall = (error: CaptureConfigError): PageLoadClass => ({ kind: 'config_error', error, message: CONFIG_ERROR_MESSAGES[error] });

  if (final && isVercelWall(final)) return wall('protection_bypass_missing');
  if ((input.status === 401 || input.status === 403) && input.bodyText && /vercel/i.test(input.bodyText) && /authentication/i.test(input.bodyText)) {
    return wall('protection_bypass_missing');
  }

  if (requested && final && requested.origin === final.origin) {
    const signIn = input.signInPaths && input.signInPaths.length > 0 ? input.signInPaths : DEFAULT_SIGN_IN_PATHS;
    if (onSignInPath(final.pathname, signIn) && !onSignInPath(requested.pathname, signIn)) {
      return wall('app_auth_not_configured');
    }
  }
  return { kind: 'ok' };
}

/**
 * The owner-setup actions a wall's question offers (failure-incident-recovery
 * §16.2, AC-17): each is something only the workspace owner can do. Never
 * retry or cancel: neither fixes a wall.
 */
export const CONFIG_ERROR_SETUP_ACTIONS: Record<CaptureConfigError, ReadonlyArray<{ label: string; description: string }>> = {
  protection_bypass_missing: [
    { label: 'Add the Vercel protection bypass', description: `Create a Protection Bypass for Automation secret in the Vercel project and map it as ${VERCEL_BYPASS_ENV}; the audit then captures the preview.` },
    { label: 'Use the sandbox page source', description: 'Set gitConfig.visualQa.pageSource to "sandbox"; the audit captures the app booted in the sandbox instead of the preview.' },
  ],
  app_auth_not_configured: [
    { label: 'Add a preview auth bypass', description: 'Set a preview-only auth bypass env var in the Vercel Preview environment; the audit then signs in as a fixed test user.' },
    { label: 'Store a storageState secret', description: `Store a Playwright storageState as a secret mapped as ${STORAGE_STATE_ENV}; sessions in it expire.` },
    { label: 'Use the sandbox page source', description: 'Set gitConfig.visualQa.pageSource to "sandbox"; the audit captures the app booted in the sandbox instead of the preview.' },
  ],
};

// ---------------------------------------------------------------------------
// Capture failures (docs/specs/failure-incident-recovery.md §16.2, §16.3, §16.5)
// ---------------------------------------------------------------------------

/** The closed v1 set of capture-path components an infrastructure failure names. */
export const CAPTURE_FAILURE_COMPONENTS = [
  'visual_qa.clone',
  'visual_qa.migrate',
  'visual_qa.scrub',
  'visual_qa.guard',
  'visual_qa.boot',
  'visual_qa.browser',
] as const;
export type CaptureFailureComponent = (typeof CAPTURE_FAILURE_COMPONENTS)[number];

/**
 * visual-qa.yml step name -> component. A step not listed here is
 * `inconclusive`: unknown ownership is explicit, never a person's question.
 * The capture step's own failures are typed by capture.ts (boot vs browser);
 * this entry is the fallback for a capture that died without saying.
 */
export const CAPTURE_STEP_COMPONENTS: Record<string, CaptureFailureComponent> = {
  'Install Playwright + Chromium': 'visual_qa.browser',
  'Create Neon prod-clone branch': 'visual_qa.clone',
  'Run migrations': 'visual_qa.migrate',
  'Scrub prod clone to placeholders': 'visual_qa.scrub',
  'Guard scrubbed clone': 'visual_qa.guard',
  'Start app': 'visual_qa.boot',
  'Capture screenshots and a11y snapshots': 'visual_qa.browser',
};

/** Namespace of a capture failure's `errorSignature` (toFrictionSignature). */
export const CAPTURE_FAILURE_SIGNATURE_NAMESPACE = 'visual-qa';

/** The run a failure came from. Added by the workflow; absent on a local capture. */
export interface CaptureFailureFacts {
  runId?: string;
  ref?: string;
  headSha?: string;
}

interface CaptureFailureBase extends CaptureFailureFacts {
  /** The visual-qa.yml step that failed. */
  step: string;
  /** Normalized error, the incident's `sig=` (toFrictionSignature). Equal for the same failing statement on any run. */
  errorSignature: string;
  /** The normalized error line (ids, paths, numbers replaced). Diagnostics only; never parse it. */
  error?: string;
}

/**
 * One typed capture failure, as `capture-failure.json` in the qa-screenshots
 * artifact. `infrastructure` and `inconclusive` are reported, never asked;
 * `person` is one of the two preview auth walls (owner setup).
 */
export type CaptureFailure =
  | (CaptureFailureBase & { ownership: 'infrastructure'; component: CaptureFailureComponent })
  | (CaptureFailureBase & { ownership: 'inconclusive'; component: null })
  | (CaptureFailureBase & { ownership: 'person'; component: null; configError: CaptureConfigError });

/**
 * The line of a step's output that names the failure, without psql's
 * `psql:<file>:<line>:` location or an Actions `::error::` prefix (both vary
 * per checkout and per edit of the SQL, the failure does not).
 */
export function captureErrorLine(text: string | null | undefined): string {
  if (!text) return '';
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  const line = lines.find(l => /\bERROR:|^::error|\berror\b|\bfailed\b/i.test(l)) ?? lines[0] ?? '';
  return line
    .replace(/^::error[^:]*::/, '')
    .replace(/^psql:\S*?:\d+:\s*/, '')
    .replace(/^ERROR:\s*/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function sign(text: string): string {
  return toFrictionSignature(normalizeErrorSignature(text), CAPTURE_FAILURE_SIGNATURE_NAMESPACE);
}

/**
 * Type one failed step. `component` overrides the step map when the caller
 * knows better (capture.ts tells a 5xx boot from a browser that never launched).
 */
export function classifyCaptureFailure(input: {
  step: string;
  error: string | null | undefined;
  component?: CaptureFailureComponent;
}): Extract<CaptureFailure, { ownership: 'infrastructure' | 'inconclusive' }> {
  const line = captureErrorLine(input.error);
  const errorSignature = sign(line);
  const error = line ? normalizeErrorSignature(line) : undefined;
  const component = input.component ?? CAPTURE_STEP_COMPONENTS[input.step];
  const base = { step: input.step, errorSignature, ...(error ? { error } : {}) };
  return component
    ? { ownership: 'infrastructure', component, ...base }
    : { ownership: 'inconclusive', component: null, ...base };
}

/** A preview auth wall: a person's setup (§16.2), with CONFIG_ERROR_SETUP_ACTIONS as its options. */
export function classifyConfigError(configError: CaptureConfigError, step: string): Extract<CaptureFailure, { ownership: 'person' }> {
  return { ownership: 'person', component: null, configError, step, errorSignature: sign(configError), error: CONFIG_ERROR_MESSAGES[configError] };
}

const CONFIG_ERRORS: readonly string[] = Object.keys(CONFIG_ERROR_MESSAGES);

/** Read a `capture-failure.json` (or a reported `captureFailure` field). Anything outside the closed set is null. */
export function parseCaptureFailure(raw: unknown): CaptureFailure | null {
  if (!isRecord(raw)) return null;
  const str = (k: string) => (typeof raw[k] === 'string' && raw[k] ? (raw[k] as string) : undefined);
  const step = str('step');
  const errorSignature = str('errorSignature');
  if (!step || !errorSignature) return null;
  const base: CaptureFailureBase = { step, errorSignature };
  for (const k of ['error', 'runId', 'ref', 'headSha'] as const) {
    const v = str(k);
    if (v) base[k] = v;
  }
  if (raw.ownership === 'infrastructure') {
    const c = raw.component as CaptureFailureComponent;
    return CAPTURE_FAILURE_COMPONENTS.includes(c) ? { ownership: 'infrastructure', component: c, ...base } : null;
  }
  if (raw.component !== null) return null;
  if (raw.ownership === 'inconclusive') return { ownership: 'inconclusive', component: null, ...base };
  if (raw.ownership === 'person' && CONFIG_ERRORS.includes(raw.configError as string)) {
    return { ownership: 'person', component: null, configError: raw.configError as CaptureConfigError, ...base };
  }
  return null;
}

export const CAPTURE_FAILURE_ERROR_PREFIX = 'capture_failure:';

/**
 * The auditor's `complete_task` error for a capture failure:
 * `capture_failure: <component> at <step> <the record as one-line JSON>`.
 * A failed completion persists `error` but not `structuredOutput`, so the
 * typed record rides here; read it back with parseCaptureFailureError.
 */
export function formatCaptureFailureError(f: CaptureFailure): string {
  const what = f.ownership === 'person' ? f.configError : f.component ?? 'unclassified';
  return `${CAPTURE_FAILURE_ERROR_PREFIX} ${what} at ${f.step.replace(/\s+/g, ' ')} ${JSON.stringify(f)}`;
}

export function parseCaptureFailureError(error: string | null | undefined): CaptureFailure | null {
  if (!error?.startsWith(CAPTURE_FAILURE_ERROR_PREFIX)) return null;
  const brace = error.indexOf('{');
  if (brace < 0) return null;
  try { return parseCaptureFailure(JSON.parse(error.slice(brace).trim())); } catch { return null; }
}

// ---------------------------------------------------------------------------
// Readiness for new projects
// ---------------------------------------------------------------------------

export type AppAuthStrategy = 'preview-bypass-env' | 'storage-state' | 'not-needed' | 'none';

export interface PreviewReadinessSignals {
  /** Environments of the repo's recent GitHub deployments. */
  recentDeploymentEnvironments: string[];
  previewEnvironment?: string;
  /** An unauthenticated GET of a recent preview URL, if one was made. */
  previewProbe?: { status: number; location?: string | null; bodyText?: string | null } | null;
  /** Labels of the workspace's secrets (values are never read). */
  secretLabels: string[];
  /** `gitConfig.envMapping`: ENV_NAME -> secret label. */
  envMapping: Record<string, string>;
  /** Env var names the repo declares (e.g. from `.env.example`). */
  repoEnvNames?: string[];
  previewAuthBypassEnv?: string;
  /** Whether the app has a login at all. Unknown counts as yes. */
  appHasLogin?: boolean;
}

export interface PreviewReadiness {
  previewsDetected: boolean;
  /** null when no probe was made. */
  previewProtected: boolean | null;
  protectionBypassConfigured: boolean;
  appAuthStrategy: AppAuthStrategy;
  recommendedPageSource: PageSourceMode;
  /** Ordered, human-readable next steps. */
  recommendation: string[];
}

function probeIsProtected(probe: NonNullable<PreviewReadinessSignals['previewProbe']>): boolean {
  const loc = probe.location ? safeUrl(probe.location) : null;
  if (loc && isVercelWall(loc)) return true;
  return (probe.status === 401 || probe.status === 403) && !!probe.bodyText && /vercel/i.test(probe.bodyText);
}

/**
 * Repo + GitHub signals -> whether this workspace can audit against its
 * previews, and exactly what to set up if not. Called by the workspace
 * onboarding readiness report.
 */
export function detectPreviewReadiness(s: PreviewReadinessSignals): PreviewReadiness {
  const env = s.previewEnvironment ?? 'Preview';
  const bypassEnv = s.previewAuthBypassEnv ?? DEFAULT_PREVIEW_AUTH_BYPASS_ENV;
  const labels = new Set(s.secretLabels);
  const mapped = (name: string) => !!s.envMapping[name] && labels.has(s.envMapping[name]);

  const previewsDetected = s.recentDeploymentEnvironments.some(e => matchesPreviewEnvironment(e, env));
  const previewProtected = s.previewProbe ? probeIsProtected(s.previewProbe) : null;
  const protectionBypassConfigured = mapped(VERCEL_BYPASS_ENV);

  let appAuthStrategy: AppAuthStrategy = 'none';
  if (s.appHasLogin === false) appAuthStrategy = 'not-needed';
  else if ((s.repoEnvNames ?? []).includes(bypassEnv)) appAuthStrategy = 'preview-bypass-env';
  else if (mapped(STORAGE_STATE_ENV)) appAuthStrategy = 'storage-state';

  const recommendation: string[] = [];
  if (!previewsDetected) {
    recommendation.push(`No preview deployments found (no GitHub deployment in the "${env}" environment). Keep pageSource "sandbox", or connect the repo to Vercel to get a preview per commit.`);
    return { previewsDetected, previewProtected, protectionBypassConfigured, appAuthStrategy, recommendedPageSource: 'sandbox', recommendation };
  }

  const wallCleared = protectionBypassConfigured || previewProtected === false;
  if (!wallCleared) {
    recommendation.push(
      `${previewProtected ? 'Previews are behind Vercel deployment protection.' : 'If previews are behind Vercel deployment protection:'} ` +
      `create a Protection Bypass for Automation secret in the Vercel project, store it with manage_secrets (purpose role_env_secret), and map it in gitConfig.envMapping as ${VERCEL_BYPASS_ENV}.`,
    );
  }
  if (appAuthStrategy === 'none') {
    recommendation.push(
      `Add a preview-only auth bypass: an env var (${bypassEnv}) set only in the Vercel Preview environment that signs in a fixed test user, like a dev auto-login. ` +
      `Or, second best, store a Playwright storageState as a secret mapped as ${STORAGE_STATE_ENV}. Sessions in a storageState expire.`,
    );
  }
  const ready = wallCleared && appAuthStrategy !== 'none';
  recommendation.push(ready
    ? 'Set gitConfig.visualQa.pageSource to "auto": audits use the READY preview and fall back to the sandbox when there is none.'
    : 'Until then keep pageSource "sandbox"; "auto" would hit the wall and ask you on every audit.');

  return {
    previewsDetected,
    previewProtected,
    protectionBypassConfigured,
    appAuthStrategy,
    recommendedPageSource: ready ? 'auto' : 'sandbox',
    recommendation,
  };
}
