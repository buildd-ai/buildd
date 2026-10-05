/**
 * Quality Scout probe executors — `planScoutProbe` + `runScoutProbe`.
 *
 * Adapters, not a stack. A selected probe (`./ledger.ts` `ScoutProbeRecord`)
 * already carries its invariant, evidence requirements and the capability
 * chosen to exercise it (`../scout-capabilities`). This module only:
 *
 *  1. **Plans** the probe against that capability: which adapter, which exact
 *     command / request / routes. Anything unsafe or unavailable is refused
 *     here, before any I/O, as `unsupported` or `needs-human` — never
 *     approximated by a weaker check.
 *  2. **Gathers** through host-supplied, read-only ports (`ScoutProbePorts`).
 *     There is no write port: no merge, no push, no Recall/learn, no fix. A
 *     host that offers no port for an adapter gets `unsupported` from the
 *     substrate's capability gate (`host:<adapter>`), not a skipped check.
 *  3. **Judges** the gathered input with a synchronous substrate executor, run
 *     through `executeScoutProbe` → `runVerificationCheck`. So the order
 *     capability → evidence → executor, the verdict vocabulary, signatures and
 *     provenance are the shared ones; short evidence is `inconclusive`.
 *
 * Reused, not restated: the Visual Auditor's auth-wall classifier
 * (`classifyPageLoad`) and capture-ref check (`captureRefMatch`), the spec
 * validator's `AssertionResult`, and the recomputed `ReadinessReport`.
 *
 * Writes are refused by default. A mutating capability is only usable when the
 * workspace declared an ephemeral test environment, and even then the caller
 * must opt in (`allowEphemeralWrites`) — a shadow run never mutates.
 */

import type { ScoutProbeKind } from '../decision-kind-scout-probe-selection';
import type { AssertionResult } from '../spec-conformance';
import type { ScoutCapability, ScoutCapabilityKind, ScoutCapabilityProfile } from '../scout-capabilities';
import { captureRefMatch } from '../visual-qa-capture-ref';
import { classifyPageLoad, CONFIG_ERROR_MESSAGES } from '../visual-qa-page-source';
import type { ReadinessItemId, ReadinessReport } from '../workspace-readiness';
import type { CaptureConfigError } from '../visual-qa-page-source';
import type { EvidenceCoverage, VerificationExecutor, VerificationObservation } from '../verification-check';
import {
  COMMAND_EVIDENCE_KEY,
  judgeCommand as judgeCommandOutput,
  parseCommandExpectation,
  unsafeCommandRule,
  type ScoutCommandExpectation,
  type ScoutCommandOutput,
  type ScoutCommandRequest,
} from './adapters/command';
import {
  CONTRACT_EVIDENCE_KEY,
  isAuthWall,
  judgeApi as judgeHttpExchange,
  parseHttpExpectation,
  READ_ONLY_METHODS,
  type ScoutHttpExpectation,
  type ScoutHttpRequest,
  type ScoutHttpResponse,
} from './adapters/contract';
import { evidenceRefs as refs } from './adapters/shared';
import { SCOUT_EVIDENCE_REQUIREMENTS } from './candidates';
import { executeScoutProbe } from './ledger';
import type { ScoutProbeRecord, ScoutReproducibility, ScoutRun } from './types';

// The command and API/contract adapters live in ./adapters; re-exported so
// callers keep one import path.
export {
  parseCommandExpectation,
  SCOUT_UNSAFE_COMMAND_RULES,
  unsafeCommandRule,
  type ScoutCommandExpectation,
  type ScoutCommandOutput,
  type ScoutCommandRequest,
} from './adapters/command';
export { parseHttpExpectation, type ScoutHttpExpectation, type ScoutHttpRequest, type ScoutHttpResponse } from './adapters/contract';

// ── Adapters ────────────────────────────────────────────────────────────────

export const SCOUT_ADAPTERS = ['command', 'api', 'surface', 'spec', 'readiness'] as const;
export type ScoutAdapterKind = (typeof SCOUT_ADAPTERS)[number];

/** Capability kind → the adapter that exercises it. Unlisted kinds have no adapter yet. */
const ADAPTER_BY_KIND: Partial<Record<ScoutCapabilityKind, ScoutAdapterKind>> = {
  'verification-command': 'command',
  'typecheck-command': 'command',
  'build-command': 'command',
  'cli-journey': 'command',
  'api-journey': 'api',
  'ui-surface': 'surface',
  spec: 'spec',
  release: 'readiness',
};

/** The evidence key each adapter natively produces, usable directly as a requirement key. */
export const SCOUT_ADAPTER_EVIDENCE: Readonly<Record<ScoutAdapterKind, string>> = {
  command: COMMAND_EVIDENCE_KEY,
  api: CONTRACT_EVIDENCE_KEY,
  surface: 'route-capture',
  spec: 'spec-assertions',
  readiness: 'readiness-state',
};

/** Which adapters can supply each probe kind's evidence requirements. */
const PROBE_KIND_ADAPTERS: Readonly<Record<ScoutProbeKind, readonly ScoutAdapterKind[]>> = {
  route_smoke: ['surface', 'api'],
  api_contract: ['api', 'command'],
  visual: ['surface'],
  spec_invariant: ['spec', 'readiness', 'command'],
  regression: ['command', 'api'],
  security_boundary: ['api'],
};

const REQUIREMENT_ADAPTERS: ReadonlyMap<string, ReadonlySet<ScoutAdapterKind>> = (() => {
  const m = new Map<string, Set<ScoutAdapterKind>>();
  const add = (key: string, a: ScoutAdapterKind) => m.set(key, (m.get(key) ?? new Set()).add(a));
  for (const [kind, keys] of Object.entries(SCOUT_EVIDENCE_REQUIREMENTS) as Array<[ScoutProbeKind, readonly string[]]>) {
    for (const key of keys) for (const a of PROBE_KIND_ADAPTERS[kind]) add(key, a);
  }
  for (const a of SCOUT_ADAPTERS) add(SCOUT_ADAPTER_EVIDENCE[a], a);
  return m;
})();

/**
 * Coverage per requirement key for what `adapter` gathered. A key the adapter
 * cannot supply stays `absent` — a CLI run never stands in for a screenshot.
 */
export function scoutEvidenceCoverage(
  requirementKeys: readonly string[],
  adapter: ScoutAdapterKind,
  gathered: EvidenceCoverage,
): Record<string, EvidenceCoverage> {
  const out: Record<string, EvidenceCoverage> = {};
  for (const key of requirementKeys) out[key] = REQUIREMENT_ADAPTERS.get(key)?.has(adapter) ? gathered : 'absent';
  return out;
}

// ── Ports (read-only by construction) ───────────────────────────────────────

export type ScoutViewport = 'phone' | 'desktop';
export const SCOUT_VIEWPORTS: readonly ScoutViewport[] = ['phone', 'desktop'];

export interface ScoutCaptureRequest {
  routes: string[];
  viewports: ScoutViewport[];
  ref: string;
  sha: string;
  /** The ui-surface capability's page source (e.g. `sandbox`, `vercel-preview`). */
  pageSource: string | null;
}

/** One Visual Auditor capture, as its shot metadata records it. */
export interface ScoutCaptureShot {
  route: string;
  viewport: ScoutViewport;
  requestedUrl: string;
  finalUrl: string;
  status: number | null;
  bodyText?: string | null;
  /** Uncaught page errors during load. */
  pageErrors?: number;
  /** `metadata.qa.ref` / `refSource` of the shot. */
  ref?: string | null;
  refSource?: string | null;
  evidenceRef?: string | null;
  /**
   * The capture already classified this navigation as an auth wall (the
   * Visual Auditor's `configError`). Honoured as-is: the classifier cannot
   * always re-derive it from the fields above.
   */
  configError?: CaptureConfigError | null;
}

export interface ScoutSpecEvaluation {
  results: AssertionResult[];
  evidenceRef?: string | null;
}

export interface ScoutReadinessSnapshot {
  report: ReadinessReport;
  evidenceRef?: string | null;
}

/**
 * What the host can do for a probe. Every port reads or runs against a
 * throwaway checkout / declared test environment; none writes anywhere else.
 * Adding a write port here is a policy change, not a refactor.
 */
export interface ScoutProbePorts {
  command?: { run(req: ScoutCommandRequest): Promise<ScoutCommandOutput> };
  http?: {
    request(req: ScoutHttpRequest): Promise<ScoutHttpResponse>;
    /** Base URL of the app the host booted in its sandbox; required for `app-boot` journeys. */
    appBaseUrl?: string | null;
  };
  capture?: { capture(req: ScoutCaptureRequest): Promise<ScoutCaptureShot[]> };
  spec?: { evaluate(req: { refs: string[]; sha: string }): Promise<ScoutSpecEvaluation> };
  readiness?: { read(req: { sha: string }): Promise<ScoutReadinessSnapshot> };
}

const PORT_OF: Record<ScoutAdapterKind, keyof ScoutProbePorts> = {
  command: 'command',
  api: 'http',
  surface: 'capture',
  spec: 'spec',
  readiness: 'readiness',
};

// ── Plan ────────────────────────────────────────────────────────────────────

export type ScoutProbeAction =
  | { adapter: 'command'; capabilityId: string; command: string; expect: ScoutCommandExpectation; mutates: boolean }
  | {
    adapter: 'api';
    capabilityId: string;
    method: string;
    path: string;
    target: 'test-environment' | 'app-boot';
    /** Set for `test-environment`; `app-boot` takes the host's base URL at run time. */
    baseUrl: string | null;
    expect: ScoutHttpExpectation;
    mutates: boolean;
  }
  | { adapter: 'surface'; capabilityId: string; routes: string[]; viewports: ScoutViewport[]; pageSource: string | null }
  | { adapter: 'spec'; capabilityId: string; refs: string[] }
  | { adapter: 'readiness'; capabilityId: string; itemIds: ReadinessItemId[] };

/**
 * `unsupported`: no way to exercise this here — nothing a person can flip.
 * `needs-human`: it could be exercised, but doing so is unsafe or blocked by a
 * workspace constraint; a person decides.
 */
export type ScoutRefusalDisposition = 'unsupported' | 'needs-human';

export type ScoutProbePlan =
  | { status: 'runnable'; action: ScoutProbeAction }
  | { status: 'refused'; disposition: ScoutRefusalDisposition; code: string; detail: string };

export interface ScoutPlanOptions {
  /** Permit a mutating probe against the declared ephemeral environment. Default false. */
  allowEphemeralWrites?: boolean;
  /** Concrete routes for a surface probe when the capability declares none (or only patterns). */
  routes?: readonly string[];
}

const refuse = (disposition: ScoutRefusalDisposition, code: string, detail: string): ScoutProbePlan => ({
  status: 'refused',
  disposition,
  code,
  detail,
});

const MAX_ROUTES = 8;

function concreteRoutes(routes: readonly string[]): string[] {
  // `/items/:id` or `/a/*` cannot be navigated to without inventing a value.
  return [...new Set(routes.filter((r) => typeof r === 'string' && r.startsWith('/') && !r.startsWith('//') && !/[:*[\]]/.test(r)))].slice(
    0,
    MAX_ROUTES,
  );
}

function commandOf(cap: ScoutCapability): string | undefined {
  if (cap.journey?.kind === 'cli') return cap.journey.command;
  return cap.value;
}

/**
 * Decide how — and whether — a selected probe can be exercised. Pure; no I/O.
 * Re-checks the capability rather than trusting the generator's choice.
 */
export function planScoutProbe(probe: ScoutProbeRecord, profile: ScoutCapabilityProfile, opts: ScoutPlanOptions = {}): ScoutProbePlan {
  if (probe.selection.status !== 'selected') return refuse('unsupported', 'not_selected', 'Only a selected probe is executed.');
  if (!probe.executor) return refuse('unsupported', 'no_executor', probe.unsupportedReason ?? 'No usable capability matched this probe.');
  const cap = profile.capabilities.find((c) => c.id === probe.executor);
  if (!cap) return refuse('unsupported', 'capability_not_found', `Capability ${probe.executor} is not in the workspace profile.`);
  if (!cap.usable) {
    return cap.status === 'available'
      ? refuse('needs-human', 'capability_blocked', cap.blockedReason ?? 'Blocked by a workspace constraint.')
      : refuse('unsupported', 'capability_unavailable', cap.blockedReason ?? `Capability ${cap.id} is ${cap.status}.`);
  }
  const adapter = ADAPTER_BY_KIND[cap.kind];
  if (!adapter) return refuse('unsupported', `no_adapter:${cap.kind}`, `No Scout executor exercises ${cap.kind} capabilities yet.`);

  const mutates = cap.mutates || probe.mutates;
  if (mutates && !opts.allowEphemeralWrites) {
    return refuse('needs-human', 'mutating_probe_requires_opt_in', 'The probe writes; this run was not allowed to write, even to an ephemeral environment.');
  }

  switch (adapter) {
    case 'command': {
      const command = commandOf(cap)?.trim();
      if (!command) return refuse('unsupported', 'no_command', `Capability ${cap.id} names no command.`);
      const rule = unsafeCommandRule(command);
      if (rule) return refuse('needs-human', `unsafe_command:${rule}`, 'The command could write outside a throwaway checkout; it is never run by a probe.');
      const forbidden = profile.constraints.forbiddenPatterns.find((p) => command.includes(p));
      if (forbidden) return refuse('needs-human', 'forbidden_pattern', `The command contains the workspace's forbidden pattern "${forbidden}".`);
      const expect = parseCommandExpectation(cap.journey?.expect);
      if (!expect) return refuse('unsupported', 'unparseable_expectation', 'The journey\'s expected outcome is not one a probe can check mechanically.');
      return { status: 'runnable', action: { adapter, capabilityId: cap.id, command, expect, mutates } };
    }
    case 'api': {
      const j = cap.journey;
      if (j?.kind !== 'api') return refuse('unsupported', 'no_journey', `Capability ${cap.id} declares no API journey.`);
      if (!j.path.startsWith('/') || j.path.startsWith('//')) return refuse('needs-human', 'absolute_path', 'API journeys must be relative to the declared environment.');
      if (!READ_ONLY_METHODS.has(j.method) && !mutates) return refuse('needs-human', 'write_method_not_declared_mutating', `${j.method} writes.`);
      const target = cap.target;
      if (!target) return refuse('unsupported', 'no_target', 'No test environment and no bootable app to send the request to.');
      if (target === 'app-boot' && mutates) return refuse('needs-human', 'mutating_app_boot', 'Writes are only sent to a declared ephemeral environment.');
      const baseUrl = target === 'test-environment' ? (profile.capabilities.find((c) => c.kind === 'test-environment')?.value ?? null) : null;
      if (target === 'test-environment' && !baseUrl) return refuse('unsupported', 'no_base_url', 'The test environment declares no base URL.');
      const expect = parseHttpExpectation(j.expect);
      if (!expect) return refuse('unsupported', 'unparseable_expectation', 'The journey\'s expected outcome is not one a probe can check mechanically.');
      return { status: 'runnable', action: { adapter, capabilityId: cap.id, method: j.method, path: j.path, target, baseUrl, expect, mutates } };
    }
    case 'surface': {
      const routes = concreteRoutes([...(cap.routes ?? []), ...(opts.routes ?? [])]);
      if (routes.length === 0) return refuse('unsupported', 'no_concrete_routes', 'No concrete route to capture (patterns with parameters are not guessed).');
      return { status: 'runnable', action: { adapter, capabilityId: cap.id, routes, viewports: [...SCOUT_VIEWPORTS], pageSource: cap.value ?? null } };
    }
    case 'spec':
      return { status: 'runnable', action: { adapter, capabilityId: cap.id, refs: probe.sourceSignals.filter((s) => s.type === 'spec').map((s) => s.ref) } };
    case 'readiness': {
      const fromSignals = probe.sourceSignals.filter((s) => s.type === 'readiness').map((s) => s.ref as ReadinessItemId);
      const itemIds = fromSignals.length > 0 ? fromSignals : cap.readinessItemId ? [cap.readinessItemId] : [];
      if (itemIds.length === 0) return refuse('unsupported', 'no_readiness_item', 'No readiness item to check.');
      return { status: 'runnable', action: { adapter, capabilityId: cap.id, itemIds } };
    }
  }
}

// ── Judges (synchronous substrate executors) ────────────────────────────────

interface CommandInput { action: Extract<ScoutProbeAction, { adapter: 'command' }>; output: ScoutCommandOutput | null }
interface ApiInput { action: Extract<ScoutProbeAction, { adapter: 'api' }>; url: string; response: ScoutHttpResponse | null }
interface SurfaceInput { action: Extract<ScoutProbeAction, { adapter: 'surface' }>; shots: ScoutCaptureShot[]; expectedRef: string }
interface SpecInput { action: Extract<ScoutProbeAction, { adapter: 'spec' }>; evaluation: ScoutSpecEvaluation | null }
interface ReadinessInput { action: Extract<ScoutProbeAction, { adapter: 'readiness' }>; snapshot: ScoutReadinessSnapshot | null }

const judgeCommand = ({ action, output }: CommandInput) => judgeCommandOutput({ expect: action.expect, output });
const judgeApi = ({ action, url, response }: ApiInput) =>
  judgeHttpExchange({ method: action.method, path: action.path, url, expect: action.expect, response });

/** Shots that count: captured from the candidate ref (or unknowably so), with stored evidence. */
function countedShots(shots: readonly ScoutCaptureShot[], expectedRef: string): ScoutCaptureShot[] {
  return shots.filter((s) => captureRefMatch({ ref: s.ref, refSource: s.refSource }, expectedRef) !== 'mismatch');
}

/** The auth-wall message for a shot, or null: the capture's own verdict first, then the classifier. */
function shotWall(s: ScoutCaptureShot): string | null {
  if (s.configError) return CONFIG_ERROR_MESSAGES[s.configError];
  const wall = classifyPageLoad({ requestedUrl: s.requestedUrl, finalUrl: s.finalUrl, status: s.status, bodyText: s.bodyText });
  return wall.kind === 'config_error' ? wall.message : null;
}

function judgeSurface({ shots, expectedRef }: SurfaceInput): VerificationObservation {
  const counted = countedShots(shots, expectedRef);
  const evidenceRefs = counted.flatMap((s) => refs(SCOUT_ADAPTER_EVIDENCE.surface, s.evidenceRef));
  for (const s of counted) {
    // An auth wall is the owner's config, never a defect of the page.
    const wall = shotWall(s);
    if (wall) return { verdict: 'unsupported', observed: wall, evidenceRefs };
  }
  if (counted.some((s) => s.status === null)) return { verdict: 'inconclusive', observed: 'A route never finished loading.', evidenceRefs };
  const broken = counted.filter((s) => (s.status as number) >= 400 || (s.pageErrors ?? 0) > 0);
  if (broken.length > 0) {
    const keys = [...new Set(broken.map((s) => `${s.route}:${(s.status as number) >= 400 ? s.status : 'page-error'}`))].sort();
    return {
      verdict: 'fail',
      observed: `Broken at the candidate: ${broken.map((s) => `${s.route} (${s.viewport}) ${s.status}${s.pageErrors ? `, ${s.pageErrors} page error(s)` : ''}`).join('; ')}.`,
      evidenceRefs,
      confidence: 1,
      signatureParts: keys,
    };
  }
  return {
    verdict: 'pass',
    // Rendering without error is what was checked; layout is the Visual Auditor's judgement.
    observed: `${new Set(counted.map((s) => s.route)).size} route(s) rendered without error at ${[...new Set(counted.map((s) => s.viewport))].join(' and ')} width; layout not judged.`,
    evidenceRefs,
  };
}

function judgeSpec({ evaluation }: SpecInput): VerificationObservation {
  const results = evaluation?.results ?? [];
  const evidenceRefs = refs(SCOUT_ADAPTER_EVIDENCE.spec, evaluation?.evidenceRef);
  const failed = results.filter((r) => r.outcome === 'fail');
  if (failed.length > 0) {
    return {
      verdict: 'fail',
      observed: failed.map((f) => `${f.id}: ${f.detail}`).join('; '),
      evidenceRefs,
      confidence: 1,
      signatureParts: failed.map((f) => f.id).sort(),
    };
  }
  if (!results.some((r) => r.outcome === 'pass')) return { verdict: 'inconclusive', observed: 'Every assertion is suppressed; nothing was evaluated.', evidenceRefs };
  return { verdict: 'pass', observed: `${results.filter((r) => r.outcome === 'pass').length} assertion(s) hold.`, evidenceRefs, confidence: 1 };
}

function judgeReadiness({ action, snapshot }: ReadinessInput): VerificationObservation {
  if (!snapshot) return { verdict: 'inconclusive', observed: 'No readiness report.' };
  const evidenceRefs = refs(SCOUT_ADAPTER_EVIDENCE.readiness, snapshot.evidenceRef);
  const items = action.itemIds.map((id) => ({ id, item: snapshot.report.items.find((i) => i.id === id) }));
  const missing = items.filter((x) => x.item && !x.item.waived && x.item.status === 'missing');
  if (missing.length > 0) {
    return {
      verdict: 'fail',
      observed: `Missing at the candidate: ${missing.map((m) => m.id).join(', ')}.`,
      evidenceRefs,
      confidence: 1,
      signatureParts: missing.map((m) => `${m.id}:missing`).sort(),
    };
  }
  const unsettled = items.filter((x) => !x.item || (!x.item.waived && x.item.status === 'unknown'));
  if (unsettled.length > 0) return { verdict: 'inconclusive', observed: `Readiness could not tell: ${unsettled.map((u) => u.id).join(', ')}.`, evidenceRefs };
  return { verdict: 'pass', observed: `${items.map((i) => i.id).join(', ')} present at the candidate.`, evidenceRefs, confidence: 1 };
}

// ── Gather ──────────────────────────────────────────────────────────────────

export const DEFAULT_COMMAND_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_HTTP_TIMEOUT_MS = 30_000;
export const MAX_SCOUT_ATTEMPTS = 3;

export interface ScoutRunProbeOptions extends ScoutPlanOptions {
  /** Repeat a failing probe up to this many times to tell deterministic from intermittent. Default 1, max 3. */
  attempts?: number;
  commandTimeoutMs?: number;
  httpTimeoutMs?: number;
  /** Applied to every output excerpt before it is judged or recorded (e.g. `createSecretRedactor`). */
  redact?: (text: string) => string;
  now?: () => Date;
}

interface Gathered {
  input: unknown;
  coverage: EvidenceCoverage;
  /** Gathering hit an auth wall or config error a person must fix. */
  configError: boolean;
}

const cov = (present: boolean, stored: boolean): EvidenceCoverage => (!present ? 'absent' : stored ? 'complete' : 'partial');

async function gather(action: ScoutProbeAction, run: ScoutRun, ports: ScoutProbePorts, opts: ScoutRunProbeOptions): Promise<Gathered> {
  const redact = opts.redact ?? ((s: string) => s);
  const clean = (s: string | null | undefined) => (typeof s === 'string' ? redact(s) : s);
  const { ref, sha } = run.candidate;
  switch (action.adapter) {
    case 'command': {
      const raw = await ports.command!.run({ command: action.command, timeoutMs: opts.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, ref, sha });
      const output = raw ? { ...raw, stdoutTail: clean(raw.stdoutTail) ?? undefined, stderrTail: clean(raw.stderrTail) ?? undefined } : null;
      return { input: { action, output } satisfies CommandInput, coverage: cov(!!output, !!output?.evidenceRef), configError: false };
    }
    case 'api': {
      const base = action.target === 'app-boot' ? ports.http!.appBaseUrl : action.baseUrl;
      if (!base) return { input: { action, url: '', response: null } satisfies ApiInput, coverage: 'absent', configError: false };
      const url = new URL(action.path, `${base.replace(/\/+$/, '')}/`).toString();
      // Never leave the declared origin, whatever the path contains.
      if (new URL(url).origin !== new URL(base).origin) return { input: { action, url, response: null } satisfies ApiInput, coverage: 'absent', configError: false };
      const raw = await ports.http!.request({ method: action.method, url, timeoutMs: opts.httpTimeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS });
      const response = raw ? { ...raw, bodyExcerpt: clean(raw.bodyExcerpt) ?? undefined } : null;
      const wall = !!response && isAuthWall(url, response);
      return { input: { action, url, response } satisfies ApiInput, coverage: cov(response?.status != null, !!response?.evidenceRef), configError: wall };
    }
    case 'surface': {
      const raw = (await ports.capture!.capture({ routes: action.routes, viewports: action.viewports, ref, sha, pageSource: action.pageSource })) ?? [];
      const shots = raw.map((s) => ({ ...s, bodyText: clean(s.bodyText) ?? null }));
      const counted = countedShots(shots, ref);
      const want = action.routes.length * action.viewports.length;
      const have = new Set(counted.filter((s) => s.evidenceRef).map((s) => `${s.route}|${s.viewport}`)).size;
      const coverage: EvidenceCoverage = counted.length === 0 ? 'absent' : have >= want ? 'complete' : 'partial';
      const configError = counted.some((s) => shotWall(s) !== null);
      return { input: { action, shots, expectedRef: ref } satisfies SurfaceInput, coverage, configError };
    }
    case 'spec': {
      const evaluation = await ports.spec!.evaluate({ refs: action.refs, sha });
      const present = !!evaluation && evaluation.results.length > 0;
      return { input: { action, evaluation } satisfies SpecInput, coverage: cov(present, !!evaluation?.evidenceRef), configError: false };
    }
    case 'readiness': {
      const snapshot = await ports.readiness!.read({ sha });
      // A truncated tree proves nothing absent: the evidence is only partial.
      const coverage: EvidenceCoverage = !snapshot ? 'absent' : snapshot.report.truncated || !snapshot.evidenceRef ? 'partial' : 'complete';
      return { input: { action, snapshot } satisfies ReadinessInput, coverage, configError: false };
    }
  }
}

const JUDGE: Record<ScoutAdapterKind, (input: never) => VerificationObservation> = {
  command: judgeCommand,
  api: judgeApi,
  surface: judgeSurface,
  spec: judgeSpec,
  readiness: judgeReadiness,
};

/** Pure over the checked-out tree: the same SHA gives the same answer. */
const DETERMINISTIC_ADAPTERS: ReadonlySet<ScoutAdapterKind> = new Set(['spec', 'readiness']);

// ── Run ─────────────────────────────────────────────────────────────────────

/** Everything a person needs to re-run the probe by hand. Never a secret: excerpts are not included. */
export type ScoutReproduction = { ref: string; sha: string; capabilityId: string } & (
  | { adapter: 'command'; command: string }
  | { adapter: 'api'; method: string; path: string; target: 'test-environment' | 'app-boot' }
  | { adapter: 'surface'; routes: string[]; viewports: ScoutViewport[] }
  | { adapter: 'spec'; refs: string[] }
  | { adapter: 'readiness'; itemIds: ReadinessItemId[] }
);

export interface ScoutProbeExecution {
  /** The probe with its substrate result attached. */
  probe: ScoutProbeRecord;
  plan: ScoutProbePlan;
  /** A person must act before this probe can say anything: unsafe, blocked, or an auth wall. */
  needsHuman: boolean;
  reproducibility: ScoutReproducibility;
  attempts: number;
  reproduction: ScoutReproduction | null;
}

function reproductionOf(action: ScoutProbeAction, run: ScoutRun): ScoutReproduction {
  const base = { ref: run.candidate.ref, sha: run.candidate.sha, capabilityId: action.capabilityId };
  switch (action.adapter) {
    case 'command': return { ...base, adapter: 'command', command: action.command };
    case 'api': return { ...base, adapter: 'api', method: action.method, path: action.path, target: action.target };
    case 'surface': return { ...base, adapter: 'surface', routes: [...action.routes], viewports: [...action.viewports] };
    case 'spec': return { ...base, adapter: 'spec', refs: [...action.refs] };
    case 'readiness': return { ...base, adapter: 'readiness', itemIds: [...action.itemIds] };
  }
}

/**
 * Plan, gather and judge one selected probe. Never throws for anything the
 * host or the workspace does; a port that throws yields `inconclusive`.
 */
export async function runScoutProbe(
  run: ScoutRun,
  probe: ScoutProbeRecord,
  profile: ScoutCapabilityProfile,
  ports: ScoutProbePorts,
  opts: ScoutRunProbeOptions = {},
): Promise<ScoutProbeExecution> {
  if (probe.selection.status !== 'selected') throw new Error(`scout probe ${probe.candidateId}: only a selected probe is executed`);
  const now = opts.now ?? (() => new Date());
  const keys = probe.evidenceRequirements.map((r) => r.key);
  const plan = planScoutProbe(probe, profile, opts);

  if (plan.status === 'refused') {
    // The refusal is a capability the host never offers, so the substrate says `unsupported` — before any evidence or executor.
    const executor: VerificationExecutor<null> = {
      kind: 'scout-refusal',
      requires: [`${plan.disposition}:${plan.code}`],
      run: () => ({ verdict: 'unsupported' }),
    };
    const result = executeScoutProbe(run, probe, executor, {
      input: null,
      evidence: {},
      capabilities: probe.executor ? [probe.executor] : [],
      now: now(),
    });
    return {
      probe: result,
      plan,
      needsHuman: plan.disposition === 'needs-human',
      reproducibility: 'unknown',
      attempts: 0,
      reproduction: null,
    };
  }

  const { action } = plan;
  const hostCap = `host:${action.adapter}`;
  const offered = [action.capabilityId, ...(ports[PORT_OF[action.adapter]] ? [hostCap] : [])];
  const judge = JUDGE[action.adapter] as (input: unknown) => VerificationObservation;
  const executor: VerificationExecutor<unknown> = { kind: `scout-${action.adapter}`, requires: [hostCap], run: judge };
  const reproduction = reproductionOf(action, run);

  const attempt = async (): Promise<{ record: ScoutProbeRecord; configError: boolean }> => {
    let gathered: Gathered = { input: null, coverage: 'absent', configError: false };
    if (offered.includes(hostCap)) {
      try {
        gathered = await gather(action, run, ports, opts);
      } catch {
        // Port errors can carry anything the host touched; the absent evidence says enough.
      }
    }
    const record = executeScoutProbe(run, probe, executor, {
      input: gathered.input,
      evidence: scoutEvidenceCoverage(keys, action.adapter, gathered.coverage),
      capabilities: offered,
      now: now(),
    });
    return { record, configError: gathered.configError };
  };

  const max = Math.min(Math.max(Math.floor(opts.attempts ?? 1), 1), MAX_SCOUT_ATTEMPTS);
  const first = await attempt();
  let attempts = 1;
  let reproducibility: ScoutReproducibility = 'unknown';
  const r = first.record.result!;
  if (DETERMINISTIC_ADAPTERS.has(action.adapter) && (r.verdict === 'pass' || r.verdict === 'fail')) {
    reproducibility = 'deterministic';
  } else if (r.verdict === 'fail' && max > 1) {
    let same = true;
    while (attempts < max) {
      const again = (await attempt()).record.result!;
      attempts++;
      if (again.verdict !== 'fail' || again.signature !== r.signature) same = false;
    }
    reproducibility = same ? 'deterministic' : 'intermittent';
  }

  return {
    probe: first.record,
    plan,
    needsHuman: first.configError,
    reproducibility,
    attempts,
    reproduction,
  };
}
