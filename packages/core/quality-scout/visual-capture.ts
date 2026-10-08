/**
 * Quality Scout's UI/surface capture port (`ScoutProbePorts.capture`),
 * implemented on the Visual Auditor's own capture: the `visual-qa.yml`
 * workflow (`scripts/qa/capture.ts`), dispatched on the candidate ref, one run
 * per viewport, and read back from the `captures.json` in its `qa-screenshots`
 * artifact. No second capture stack.
 *
 * Read-only toward the product: the dispatch passes `judge=false`, so the run
 * posts no PR comment and no check run, and capture aborts page writes. What
 * it does create is a workflow run on the workspace's repo, the same one a
 * worker creates with `gh workflow run visual-qa.yml` (CLAUDE.md, /visual-review).
 *
 * Only the sandbox page source is served here. A Vercel-preview workspace is
 * captured by a browser-capable visual-auditor runner; this host has no
 * browser, so `resolveScoutCapturePort` offers no port and the probe is
 * `unsupported` through the substrate's `host:surface` gate, never a weaker
 * check. Likewise for a repo without the workflow (any non-Buildd repo that
 * never adopted it).
 *
 * Slow: a run boots the app on a GitHub runner (minutes). Call from a worker
 * or background job, never a request handler.
 *
 * Pure apart from the `VisualQaActions` it is handed, so both hosts share it:
 * the server builds one over the workspace's GitHub App installation
 * (apps/web/src/lib/quality-scout-visual-adapter.ts), a runner builds one
 * over the run-scoped token its Scout claim carried (`tokenVisualQaActions`).
 */
import { inflateRawSync } from 'node:zlib';
import type {
  ScoutCaptureRequest,
  ScoutCaptureShot,
  ScoutProbePorts,
  ScoutViewport,
} from './executors';
import { resolveVisualQaConfig, type CaptureConfigError } from '../visual-qa-page-source';

export const VISUAL_QA_WORKFLOW_FILE = 'visual-qa.yml';
export const VISUAL_QA_ARTIFACT = 'qa-screenshots';
export const VISUAL_QA_CAPTURES_FILE = 'captures.json';

/** Scout viewport → the workflow's `viewport` input. */
const WORKFLOW_VIEWPORT: Record<ScoutViewport, string> = { phone: 'mobile', desktop: 'desktop' };

export const DEFAULT_CAPTURE_TIMEOUT_MS = 25 * 60_000;
const DEFAULT_POLL_MS = 15_000;
/** Clock skew tolerated between buildd and GitHub's run timestamps. */
const CLOCK_SKEW_MS = 15_000;

// ── GitHub Actions seam ─────────────────────────────────────────────────────

export interface VisualQaRun {
  id: number;
  status: string;
  conclusion: string | null;
  headSha: string;
  headBranch: string | null;
  createdAt: string;
}

/** The handful of Actions calls the port makes. Injected so the port is testable without GitHub. */
export interface VisualQaActions {
  repoFullName: string;
  /** False on a 404: the repo has no Visual QA workflow. */
  workflowExists(): Promise<boolean>;
  dispatch(ref: string, inputs: Record<string, string>): Promise<void>;
  /** Recent `workflow_dispatch` runs of the workflow on `ref`, newest first. */
  listDispatchRuns(ref: string): Promise<VisualQaRun[]>;
  getRun(runId: number): Promise<VisualQaRun>;
  /** One file from a run's named artifact, as text; null when the artifact or file is absent or expired. */
  readArtifactFile(runId: number, artifactName: string, path: string): Promise<string | null>;
}

export interface RawRun {
  id: number;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string | null;
  created_at: string;
}

export const toRun = (r: RawRun): VisualQaRun => ({
  id: r.id,
  status: r.status,
  conclusion: r.conclusion,
  headSha: r.head_sha,
  headBranch: r.head_branch,
  createdAt: r.created_at,
});

/**
 * One file out of a zip archive (stored or deflated), matched by its path or
 * path suffix. Enough for an Actions artifact; not a general zip reader
 * (no zip64, no encryption).
 */
export function readZipEntry(zip: Uint8Array, path: string): Uint8Array | null {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip archive');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('corrupt zip central directory');
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = decoder.decode(zip.subarray(p + 46, p + 46 + nameLen));
    if (name === path || name.endsWith(`/${path}`)) {
      if (view.getUint32(local, true) !== 0x04034b50) throw new Error('corrupt zip local header');
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = zip.subarray(start, start + compSize);
      if (method === 0) return data;
      if (method === 8) return new Uint8Array(inflateRawSync(data));
      throw new Error(`unsupported zip compression method ${method}`);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

// ── captures.json → shots ───────────────────────────────────────────────────

/** One `scripts/qa/capture.ts` record, as far as Scout reads it. */
export interface VisualQaCaptureRecord {
  path: string;
  url: string;
  finalUrl?: string;
  status?: number | null;
  pageErrors?: number;
  screenshotFile?: string;
  state?: string;
  configError?: CaptureConfigError;
  skipped?: boolean;
  error?: string;
}

/**
 * Map one run's capture records to Scout shots. Only base shots of the
 * requested routes count (a plan state shot is extra evidence, never a cell);
 * a skipped route yields no shot, so the coverage says partial. A record with
 * no recorded status (a capture script older than the field, or a navigation
 * that threw) keeps `status: null`: the judge calls that inconclusive rather
 * than guessing a 200.
 */
export function captureRecordsToShots(
  records: unknown,
  ctx: { routes: readonly string[]; viewport: ScoutViewport; ref: string | null; runId: number; repoFullName: string },
): ScoutCaptureShot[] {
  if (!Array.isArray(records)) return [];
  const wanted = new Set(ctx.routes);
  const shots: ScoutCaptureShot[] = [];
  for (const r of records as VisualQaCaptureRecord[]) {
    if (!r || typeof r.path !== 'string' || !wanted.has(r.path) || r.state || r.skipped) continue;
    const requestedUrl = typeof r.url === 'string' ? r.url : r.path;
    shots.push({
      route: r.path,
      viewport: ctx.viewport,
      requestedUrl,
      finalUrl: typeof r.finalUrl === 'string' ? r.finalUrl : requestedUrl,
      status: r.error ? null : typeof r.status === 'number' ? r.status : null,
      bodyText: null,
      ...(typeof r.pageErrors === 'number' ? { pageErrors: r.pageErrors } : {}),
      ref: ctx.ref,
      evidenceRef: r.screenshotFile
        ? `gh-actions:${ctx.repoFullName}/runs/${ctx.runId}/${VISUAL_QA_ARTIFACT}/screenshots/${r.screenshotFile}`
        : null,
      ...(r.configError ? { configError: r.configError } : {}),
    });
  }
  return shots;
}

// ── The port ────────────────────────────────────────────────────────────────

export interface VisualQaCapturePortOptions {
  /** Per viewport run: dispatch → completed. Default 25 minutes. */
  timeoutMs?: number;
  /**
   * Absolute epoch-ms bound across every viewport (a runner's lease). A run
   * still going at this point throws, like the per-viewport timeout.
   */
  deadlineMs?: number;
  pollMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export type ScoutCapturePort = NonNullable<ScoutProbePorts['capture']>;

/**
 * The capture port over `actions`. Throws (which the executor records as
 * `inconclusive`) when the run cannot be tied to the candidate commit or does
 * not finish in time; never returns shots from another commit.
 */
export function createVisualQaCapturePort(actions: VisualQaActions, opts: VisualQaCapturePortOptions = {}): ScoutCapturePort {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CAPTURE_TIMEOUT_MS;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const claimed = new Set<number>();

  async function runFor(req: ScoutCaptureRequest, viewport: ScoutViewport): Promise<VisualQaRun> {
    const dispatchedAt = now();
    const deadline = Math.min(dispatchedAt + timeoutMs, opts.deadlineMs ?? Infinity);
    if (now() >= deadline) throw new Error(`no time left to capture before the run's deadline`);
    await actions.dispatch(req.ref, { routes: req.routes.join(','), viewport: WORKFLOW_VIEWPORT[viewport], judge: 'false' });

    let run: VisualQaRun | undefined;
    while (!run) {
      // Ours: created after the dispatch, on the candidate commit, not already read.
      run = (await actions.listDispatchRuns(req.ref)).find((r) =>
        Date.parse(r.createdAt) >= dispatchedAt - CLOCK_SKEW_MS && r.headSha === req.sha && !claimed.has(r.id));
      if (run) break;
      if (now() >= deadline) throw new Error(`no ${VISUAL_QA_WORKFLOW_FILE} run on ${req.sha.slice(0, 7)} appeared`);
      await sleep(pollMs);
    }
    claimed.add(run.id);
    while (run.status !== 'completed') {
      if (now() >= deadline) throw new Error(`${VISUAL_QA_WORKFLOW_FILE} run ${run.id} did not finish in time`);
      await sleep(pollMs);
      run = await actions.getRun(run.id);
    }
    return run;
  }

  return {
    async capture(req) {
      if (req.pageSource && req.pageSource !== 'sandbox') {
        throw new Error(`page source ${req.pageSource} is captured by a browser runner, not ${VISUAL_QA_WORKFLOW_FILE}`);
      }
      const shots: ScoutCaptureShot[] = [];
      // One viewport at a time: two dispatches on the same commit would be indistinguishable.
      for (const viewport of req.viewports) {
        const run = await runFor(req, viewport);
        // A run that failed (e.g. on an auth wall) still uploads what it captured.
        const text = await actions.readArtifactFile(run.id, VISUAL_QA_ARTIFACT, VISUAL_QA_CAPTURES_FILE);
        if (text === null) continue;
        let records: unknown;
        try {
          records = JSON.parse(text);
        } catch {
          continue;
        }
        shots.push(...captureRecordsToShots(records, {
          routes: req.routes,
          viewport,
          ref: run.headBranch ?? req.ref,
          runId: run.id,
          repoFullName: actions.repoFullName,
        }));
      }
      return shots;
    },
  };
}

export type ScoutCapturePortResolution =
  | { port: ScoutCapturePort }
  | { port: null; reason: 'page_source_not_sandbox' | 'no_visual_qa_workflow'; detail: string };

/**
 * The capture port for a workspace, or why it has none. A workspace with no
 * port gets `unsupported` for every surface probe — the honest answer when
 * this host cannot capture its pages.
 */
export async function resolveScoutCapturePort(opts: {
  gitConfig: { visualQa?: unknown } | null | undefined;
  actions: VisualQaActions;
  port?: VisualQaCapturePortOptions;
}): Promise<ScoutCapturePortResolution> {
  const { pageSource } = resolveVisualQaConfig(opts.gitConfig?.visualQa);
  if (pageSource !== 'sandbox') {
    return {
      port: null,
      reason: 'page_source_not_sandbox',
      detail: `Pages come from ${pageSource}; those are captured by a browser-capable visual-auditor runner, not from here.`,
    };
  }
  if (!(await opts.actions.workflowExists())) {
    return {
      port: null,
      reason: 'no_visual_qa_workflow',
      detail: `${opts.actions.repoFullName} has no ${VISUAL_QA_WORKFLOW_FILE} workflow to capture with.`,
    };
  }
  return { port: createVisualQaCapturePort(opts.actions, opts.port) };
}

// ── Runner side: Actions over a run-scoped token ────────────────────────────

const GITHUB_API = 'https://api.github.com';
const GITHUB_HEADERS = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } as const;
/** `owner/name`, never a path segment like `..` that would walk out of `/repos/`. */
const REPO_FULL_NAME = /^(?!\.{1,2}\/)[A-Za-z0-9_.-]{1,100}\/(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

/**
 * A capture credential a Scout claim handed this runner: a GitHub App
 * installation token minted for this run alone, scoped to one repository and
 * to Actions. It is held in memory by the capture port and nothing else:
 * never written to disk, never put in any process env, never in a probe's.
 */
export interface ScoutCaptureCredential {
  token: string;
  /** Past this (the earlier of the token's own expiry and the run's lease) the port stops using it. */
  expiresAt: string;
  /** `owner/name`: the only repository the token reaches. */
  repository: string;
}

/**
 * `VisualQaActions` over a run-scoped token, for a runner. `credential()` is
 * read on every call, so dropping it (lease over, run over) stops the port at
 * once; a call after it is gone, or past `expiresAt`, throws.
 */
export function tokenVisualQaActions(opts: {
  repoFullName: string;
  credential: () => ScoutCaptureCredential | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}): VisualQaActions {
  if (!REPO_FULL_NAME.test(opts.repoFullName)) throw new Error('capture repository is not owner/name');
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const repo = `/repos/${opts.repoFullName}`;
  const workflow = `${repo}/actions/workflows/${encodeURIComponent(VISUAL_QA_WORKFLOW_FILE)}`;
  const token = (): string => {
    const c = opts.credential();
    if (!c || c.repository.toLowerCase() !== opts.repoFullName.toLowerCase()) throw new Error('no capture credential for this repository');
    if (!(Date.parse(c.expiresAt) > now())) throw new Error('the capture credential has expired');
    return c.token;
  };
  const call = async (path: string, init: RequestInit = {}): Promise<Response> =>
    doFetch(`${GITHUB_API}${path}`, {
      ...init,
      headers: { ...GITHUB_HEADERS, ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token()}` },
    });
  const json = async (path: string, init: RequestInit = {}) => {
    const res = await call(path, init);
    if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
    return res.status === 204 ? null : res.json();
  };
  return {
    repoFullName: opts.repoFullName,
    async workflowExists() {
      const res = await call(workflow);
      if (res.status === 404) return false;
      if (!res.ok) throw new Error(`GitHub API error: ${res.status}`);
      return true;
    },
    async dispatch(ref, inputs) {
      await json(`${workflow}/dispatches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref, inputs }),
      });
    },
    async listDispatchRuns(ref) {
      const data = await json(`${workflow}/runs?event=workflow_dispatch&branch=${encodeURIComponent(ref)}&per_page=10`);
      return ((data?.workflow_runs ?? []) as RawRun[]).map(toRun);
    },
    async getRun(runId) {
      return toRun(await json(`${repo}/actions/runs/${runId}`) as RawRun);
    },
    async readArtifactFile(runId, artifactName, path) {
      const data = await json(`${repo}/actions/runs/${runId}/artifacts?name=${encodeURIComponent(artifactName)}`);
      const artifact = ((data?.artifacts ?? []) as Array<{ id: number; name: string; expired: boolean }>)
        .find((a) => a.name === artifactName && !a.expired);
      if (!artifact) return null;
      // The zip endpoint redirects to blob storage; fetch drops the token on the cross-origin hop.
      const res = await call(`${repo}/actions/artifacts/${artifact.id}/zip`);
      if (res.status === 404 || res.status === 410) return null;
      if (!res.ok) throw new Error(`GitHub API error: ${res.status} reading artifact ${artifactName}`);
      const entry = readZipEntry(new Uint8Array(await res.arrayBuffer()), path);
      return entry ? new TextDecoder().decode(entry) : null;
    },
  };
}

/**
 * Revoke an installation token before its natural expiry (GitHub mints them
 * for an hour and offers no shorter lifetime). Best effort: a failure leaves
 * the token to expire on its own. Never throws.
 */
export async function revokeInstallationToken(token: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  try {
    const res = await fetchImpl(`${GITHUB_API}/installation/token`, {
      method: 'DELETE',
      headers: { ...GITHUB_HEADERS, Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10_000),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

/**
 * At most `max` captures through `port`; the next one throws, which the
 * executor records as `inconclusive`. The server's selection already caps
 * surface probes per run; this is the host's own lock on the same bound.
 */
export function limitScoutCapturePort(port: ScoutCapturePort, max: number): ScoutCapturePort {
  let used = 0;
  return {
    async capture(req) {
      if (used >= max) throw new Error(`capture cap of ${max} probe(s) per run reached`);
      used++;
      return port.capture(req);
    },
  };
}
