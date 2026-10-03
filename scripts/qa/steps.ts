/**
 * The step engine shared by scripts/qa/capture.ts (QA_PLAN states) and
 * scripts/demo/run-storyboard.ts (a step's `click` list), so the two resolve
 * selectors and drive Playwright the same way. Contract:
 * docs/specs/qa-capture-steps.md.
 *
 * Validation (parsePlan / validatePlan) is pure and runs before any browser
 * exists; runSteps needs a page. Only Playwright *types* are imported here, so
 * the module loads without a browser.
 */
import type { Locator, Page, Route } from 'playwright';

// --- Selectors ---

export type ParsedSelector =
  | { kind: 'testid'; id: string }
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'text'; text: string }
  | { kind: 'css'; css: string };

/** A bare word is a data-testid: the storyboard's rule since its first board. */
const BARE_TESTID = /^[a-z0-9][a-z0-9-_]*$/i;
const ROLE_RE = /^role:([a-z]+)(?:\[name=(.+)\])?$/i;

/**
 * `testid:<id>`, `role:<role>[name=<name>]`, `text:<text>`, `css:<css>`, a bare
 * word (a testid), or anything else as a raw CSS / Playwright selector.
 */
export function parseSelector(selector: string): ParsedSelector {
  const s = typeof selector === 'string' ? selector.trim() : '';
  if (!s) throw new Error('selector must be a non-empty string');
  if (s.startsWith('testid:')) {
    const id = s.slice('testid:'.length).trim();
    if (!id) throw new Error(`selector "${s}" names no testid`);
    return { kind: 'testid', id };
  }
  if (s.startsWith('role:')) {
    const m = ROLE_RE.exec(s);
    if (!m) throw new Error(`selector "${s}" must look like role:<role> or role:<role>[name=<name>]`);
    const name = m[2]?.trim().replace(/^(["'])(.*)\1$/, '$2');
    return name ? { kind: 'role', role: m[1].toLowerCase(), name } : { kind: 'role', role: m[1].toLowerCase() };
  }
  if (s.startsWith('text:')) {
    const text = s.slice('text:'.length).trim();
    if (!text) throw new Error(`selector "${s}" names no text`);
    return { kind: 'text', text };
  }
  if (s.startsWith('css:')) {
    const css = s.slice('css:'.length).trim();
    if (!css) throw new Error(`selector "${s}" names no css`);
    return { kind: 'css', css };
  }
  if (BARE_TESTID.test(s)) return { kind: 'testid', id: s };
  return { kind: 'css', css: s };
}

/**
 * The selector as one Playwright selector string. What the storyboard's
 * manifest records (`[data-testid="x"]` for a bare word, as before), and what
 * page.locator() takes. getByRole/getByText semantics need toLocator.
 */
export function selectorString(selector: string): string {
  const p = parseSelector(selector);
  switch (p.kind) {
    case 'testid': return `[data-testid="${p.id}"]`;
    case 'role': return p.name ? `role=${p.role}[name=${JSON.stringify(p.name)}]` : `role=${p.role}`;
    case 'text': return `text=${p.text}`;
    case 'css': return p.css;
  }
}

/** Every match of the selector. Callers pick `.first()` where one is meant. */
export function toLocator(page: Page, selector: string): Locator {
  const p = parseSelector(selector);
  switch (p.kind) {
    case 'testid': return page.getByTestId(p.id);
    case 'role': return page.getByRole(p.role as Parameters<Page['getByRole']>[0], p.name ? { name: p.name } : undefined);
    case 'text': return page.getByText(p.text);
    case 'css': return page.locator(p.css);
  }
}

// --- Steps ---

export const STEP_ACTIONS = ['click', 'hover', 'fill', 'press', 'select', 'waitFor', 'waitMs'] as const;
export type StepAction = (typeof STEP_ACTIONS)[number];

export type Step = {
  action: StepAction;
  selector?: string;
  /** fill / select. */
  value?: string;
  /** press: a Playwright key name (`Escape`, `ArrowDown`). */
  key?: string;
  /** waitFor: `visible` (default) or `hidden`. */
  state?: 'visible' | 'hidden';
  /** waitMs. Capped at WAIT_MS_CAP. */
  ms?: number;
  timeoutMs?: number;
  /** This step sends a write. Honoured only on the sandbox (see validatePlan). */
  commit?: boolean;
};

export const WAIT_MS_CAP = 5_000;
export const DEFAULT_STEP_TIMEOUT_MS = 10_000;
export const MAX_STEP_TIMEOUT_MS = 30_000;

const NEEDS_SELECTOR: ReadonlySet<StepAction> = new Set(['click', 'hover', 'fill', 'select', 'waitFor']);
const STEP_FIELDS = new Set(['action', 'selector', 'value', 'key', 'state', 'ms', 'timeoutMs', 'commit']);

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** One step, checked field by field. `where` prefixes every error. */
export function validateStep(raw: unknown, where: string): Step {
  if (!isRecord(raw)) throw new Error(`${where}: a step must be an object`);
  const unknown = Object.keys(raw).filter((k) => !STEP_FIELDS.has(k));
  if (unknown.length) throw new Error(`${where}: unknown field(s) ${unknown.join(', ')}`);
  const action = raw.action as StepAction;
  if (!STEP_ACTIONS.includes(action)) {
    throw new Error(`${where}: action must be one of ${STEP_ACTIONS.join(', ')} (got ${JSON.stringify(raw.action)})`);
  }
  const step: Step = { action };
  if (raw.selector !== undefined) {
    if (typeof raw.selector !== 'string') throw new Error(`${where}: selector must be a string`);
    try { parseSelector(raw.selector); } catch (err) { throw new Error(`${where}: ${(err as Error).message}`); }
    step.selector = raw.selector.trim();
  }
  if (NEEDS_SELECTOR.has(action) && !step.selector) throw new Error(`${where}: ${action} needs a selector`);
  if (action === 'fill' || action === 'select') {
    if (typeof raw.value !== 'string') throw new Error(`${where}: ${action} needs a string value`);
    step.value = raw.value;
  }
  if (action === 'press') {
    if (typeof raw.key !== 'string' || !raw.key.trim()) throw new Error(`${where}: press needs a key`);
    step.key = raw.key.trim();
  }
  if (action === 'waitFor' && raw.state !== undefined) {
    if (raw.state !== 'visible' && raw.state !== 'hidden') throw new Error(`${where}: waitFor state must be visible or hidden`);
    step.state = raw.state;
  }
  if (action === 'waitMs') {
    if (typeof raw.ms !== 'number' || !Number.isFinite(raw.ms) || raw.ms < 0) throw new Error(`${where}: waitMs needs ms >= 0`);
    step.ms = Math.min(raw.ms, WAIT_MS_CAP);
  }
  if (raw.timeoutMs !== undefined) {
    if (typeof raw.timeoutMs !== 'number' || !Number.isFinite(raw.timeoutMs) || raw.timeoutMs <= 0) {
      throw new Error(`${where}: timeoutMs must be a positive number`);
    }
    step.timeoutMs = Math.min(raw.timeoutMs, MAX_STEP_TIMEOUT_MS);
  }
  if (raw.commit !== undefined) {
    if (typeof raw.commit !== 'boolean') throw new Error(`${where}: commit must be true or false`);
    if (raw.commit) step.commit = true;
  }
  return step;
}

/** `click role:button[name=Start]`, for logs and errors. */
export function describeStep(step: Step): string {
  return [step.action, step.selector ?? step.key ?? (step.ms !== undefined ? `${step.ms}ms` : '')].filter(Boolean).join(' ');
}

// --- Plans ---

export type PlanState = { key: string; steps: Step[] };
export type PlanRoute = { route: string; states: PlanState[] };

const STATE_KEY = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A QA_PLAN, validated whole: `[{ route, states?: [{ key, steps }] }]`.
 *
 * The safety rule lives here, so it holds however the plan got in: a step
 * that commits (`commit: true`) is allowed only when the pages come from the
 * sandbox. On a preview they hit real data, and the whole plan is rejected
 * with the step named.
 */
export function validatePlan(raw: unknown, opts: { pageSource: string }): PlanRoute[] {
  if (!Array.isArray(raw)) throw new Error('QA_PLAN must be a JSON array of { route, states? }');
  if (raw.length === 0) throw new Error('QA_PLAN has no routes');
  const routes = new Set<string>();
  return raw.map((r, ri) => {
    if (!isRecord(r)) throw new Error(`QA_PLAN[${ri}]: must be an object`);
    if (typeof r.route !== 'string' || !r.route.trim().startsWith('/')) throw new Error(`QA_PLAN[${ri}]: route must be a path starting with /`);
    const route = r.route.trim();
    if (routes.has(route)) throw new Error(`QA_PLAN[${ri}]: route "${route}" is listed twice`);
    routes.add(route);
    if (r.states !== undefined && !Array.isArray(r.states)) throw new Error(`QA_PLAN route "${route}": states must be an array`);
    const keys = new Set<string>();
    const states = ((r.states as unknown[] | undefined) ?? []).map((s, si) => {
      if (!isRecord(s)) throw new Error(`QA_PLAN route "${route}" states[${si}]: must be an object`);
      if (typeof s.key !== 'string' || !STATE_KEY.test(s.key)) {
        throw new Error(`QA_PLAN route "${route}" states[${si}]: key must be lower-case letters, digits and dashes`);
      }
      if (keys.has(s.key)) throw new Error(`QA_PLAN route "${route}": state "${s.key}" is listed twice`);
      keys.add(s.key);
      if (!Array.isArray(s.steps) || s.steps.length === 0) throw new Error(`QA_PLAN route "${route}" state "${s.key}": steps must be a non-empty array`);
      const steps = s.steps.map((raw, i) => {
        const where = `QA_PLAN route "${route}" state "${s.key}" steps[${i}]`;
        const step = validateStep(raw, where);
        if (step.commit && opts.pageSource !== 'sandbox') {
          throw new Error(
            `${where} (${describeStep(step)}) has commit: true, which is only honoured with QA_PAGE_SOURCE=sandbox ` +
              `(got ${opts.pageSource}): preview pages hit real data, so steps may open, reveal and type but never commit`,
          );
        }
        return step;
      });
      return { key: s.key, steps };
    });
    return { route, states };
  });
}

/**
 * QA_PLAN's value as plan text: inline JSON when it starts with `[` (a workflow
 * dispatch input), else a path read with `readFile`.
 */
export function planText(value: string, readFile: (path: string) => string): string {
  const v = value.trim();
  return v.startsWith('[') ? v : readFile(v);
}

export function parsePlan(text: string, opts: { pageSource: string }): PlanRoute[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    throw new Error(`QA_PLAN is not valid JSON: ${(err as Error).message}`);
  }
  return validatePlan(raw, opts);
}

// --- Running ---

export type StepFailure = { index: number; selector: string | null; error: string };

/**
 * Run steps in order on the page. Stops at the first step that fails and
 * returns where and why, so the caller can still shoot the page as it stands.
 * Never throws for a step: a missing selector is a finding, not a crash.
 */
export async function runSteps(
  page: Page,
  steps: readonly Step[],
  opts: {
    defaultTimeoutMs?: number;
    beforeStep?: (step: Step, index: number) => void;
    afterStep?: (step: Step, index: number) => void;
  } = {},
): Promise<StepFailure | null> {
  for (const [index, step] of steps.entries()) {
    const timeout = step.timeoutMs ?? opts.defaultTimeoutMs ?? DEFAULT_STEP_TIMEOUT_MS;
    opts.beforeStep?.(step, index);
    try {
      const at = () => toLocator(page, step.selector!).first();
      switch (step.action) {
        case 'click':
          await at().click({ timeout });
          // A click can navigate or fetch; let it land. Best-effort: a page
          // that keeps a socket busy never reaches networkidle.
          await page.waitForLoadState('networkidle', { timeout }).catch(() => {});
          break;
        case 'hover':
          await at().hover({ timeout });
          break;
        case 'fill':
          await at().fill(step.value ?? '', { timeout });
          break;
        case 'press':
          if (step.selector) await at().press(step.key!, { timeout });
          else await page.keyboard.press(step.key!);
          break;
        case 'select':
          await at().selectOption(step.value ?? '', { timeout });
          break;
        case 'waitFor':
          await at().waitFor({ state: step.state ?? 'visible', timeout });
          break;
        case 'waitMs':
          await page.waitForTimeout(Math.min(step.ms ?? 0, WAIT_MS_CAP));
          break;
      }
    } catch (err) {
      return { index, selector: step.selector ?? null, error: String((err as Error)?.message ?? err).split('\n')[0] };
    } finally {
      opts.afterStep?.(step, index);
    }
  }
  return null;
}

// --- The write guard ---

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Does a request with this method write? */
export function isMutatingMethod(method: string): boolean {
  return !SAFE_METHODS.has(method.toUpperCase());
}

export type BlockedWrite = { method: string; path: string };

/**
 * Abort every write the page sends until disposed, unless `allow(true)` is in
 * effect (a commit step on the sandbox). Records each aborted request's method
 * and path, never its query or body.
 */
export async function guardWrites(page: Page): Promise<{ allow: (on: boolean) => void; blocked: BlockedWrite[]; dispose: () => Promise<void> }> {
  let allowed = false;
  const blocked: BlockedWrite[] = [];
  const handler = async (route: Route) => {
    const req = route.request();
    if (allowed || !isMutatingMethod(req.method())) return route.continue();
    let path = req.url();
    try { path = new URL(path).pathname; } catch { /* keep as is */ }
    blocked.push({ method: req.method(), path });
    return route.abort('blockedbyclient');
  };
  await page.route('**/*', handler);
  return {
    allow: (on) => { allowed = on; },
    blocked,
    dispose: () => page.unroute('**/*', handler).catch(() => {}),
  };
}
