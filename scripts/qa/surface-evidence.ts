/**
 * Surface evidence: what a capture saw of one composed UI card, in the bounded
 * shape registered `verify:` checks judge (packages/core/ui-verification.ts).
 * Written beside the screenshot as QA_OUTPUT/surfaces/<shot id>.json when a
 * plan route or state names a `surface` (scripts/qa/steps.ts).
 *
 * Collection is explicit, never inferred:
 *  - The card is the one element with `data-verify-surface="<id>"`.
 *  - Its text is the elements marked `data-verify-block="<role>"`, in document
 *    order (blocks do not nest). A role is heading, status, body, label or hint,
 *    or one of the material roles a copy check never calls dispensable: a line
 *    stating a consequence, permission, prerequisite or recovery step says so.
 *    Any other role is not captured and marks the text partial.
 *  - Its actions are every interactive element inside it. What an action does
 *    is its `data-verify-action="<operation>"`, set by the component that owns
 *    the button. The label is recorded as shown and never read for meaning: an
 *    action with no declared operation is `other`, which the deterministic
 *    check reports as unsupported, not as a pass.
 *  - Prominence is `menu` inside a `role=menu`, else `data-verify-prominence`.
 *  - Disclosure is measured from the rendered page: an element that is not
 *    rendered (a closed <details>, display:none, aria-hidden) is `collapsed`.
 *  - Runtime facts (PR state, replacement, verification state) never come from
 *    the page. They are supplied independently (QA_SURFACE_FACTS), versioned by
 *    `factVersion`, per scenario. A scenario without supplied facts records
 *    none and says runtime state is absent; checks then read it as inconclusive.
 *  - Pixels are the screenshot, a separate capability: the evidence says only
 *    whether one was taken. A text-only verifier never claims to have looked.
 *
 * Anything the collector could not capture completely (too many blocks, an
 * oversized block, nested blocks, an action with no prominence or label) marks
 * that coverage `partial` and is listed in `notes`. Nothing is silently dropped.
 *
 * Who collected it is recorded (QA_SURFACE_COLLECTOR, default `agent`), but it
 * grants nothing: the server admits a capture only by the lineage of the
 * artifact it is uploaded as (lib/specs/registered-verification-store.ts).
 */
import { parseSurfaceEvidence, UI_SURFACE_BLOCK_ROLES, UI_SURFACE_OPERATIONS, type SurfaceEvidence } from '../../packages/core/ui-verification';

export const SURFACE_BLOCK_ROLES = UI_SURFACE_BLOCK_ROLES;
export const SURFACE_OPERATIONS = UI_SURFACE_OPERATIONS;
export const SURFACE_COLLECTOR_VERSION = 'buildd-qa-capture@1';
const MAX_BLOCKS = 32;
const MAX_ACTIONS = 16;
const MAX_BLOCK_TEXT = 1000;
const MAX_LABEL = 120;

/** What the browser reads off the page: plain data, so composing it stays pure. */
export type RawSurface = {
  /** How many elements carry this surface id: exactly one is a capture. */
  found: number;
  blocks: Array<{ id: string | null; role: string | null; text: string; collapsed: boolean; nested: boolean }>;
  actions: Array<{ id: string | null; operation: string | null; prominence: string | null; inMenu: boolean; label: string; enabled: boolean; collapsed: boolean }>;
};

export type SurfaceFacts = { factVersion: string; scenarios: Record<string, SurfaceEvidence['facts']> };

export type SurfaceContext = {
  commitSha: string | undefined;
  route: string;
  scenarioId: string;
  viewport: 'mobile' | 'desktop';
  captureId: string;
  capturedAt: string;
  snapshotRef: string;
  screenshot: boolean;
  facts: SurfaceFacts | null;
  collector: SurfaceEvidence['provenance']['collector'];
};

export type ComposedSurface =
  | { ok: true; evidence: SurfaceEvidence; notes: string[] }
  | { ok: false; reason: string };

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();
const ID = /^[a-z0-9][a-z0-9-]{0,99}$/;

/** QA_SURFACE_FACTS: inline JSON when it starts with `{`, else a path read with `readFile`. */
export function parseSurfaceFacts(value: string | undefined, readFile: (path: string) => string): SurfaceFacts | null {
  const v = value?.trim();
  if (!v) return null;
  const raw = JSON.parse(v.startsWith('{') ? v : readFile(v)) as unknown;
  const r = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
  if (!r || typeof r.factVersion !== 'string' || !r.factVersion.trim() || r.factVersion.length > 80) {
    throw new Error('QA_SURFACE_FACTS must be { factVersion, scenarios: { <scenario>: facts } } with a non-empty factVersion');
  }
  const scenarios = r.scenarios && typeof r.scenarios === 'object' && !Array.isArray(r.scenarios) ? (r.scenarios as Record<string, unknown>) : null;
  if (!scenarios) throw new Error('QA_SURFACE_FACTS.scenarios must be an object keyed by scenario id');
  for (const k of Object.keys(scenarios)) if (!ID.test(k)) throw new Error(`QA_SURFACE_FACTS.scenarios: "${k}" is not a scenario id`);
  return { factVersion: r.factVersion.trim(), scenarios: scenarios as SurfaceFacts['scenarios'] };
}

/** QA_SURFACE_COLLECTOR, defaulting to the least authority. */
export function surfaceCollector(value: string | undefined): SurfaceEvidence['provenance']['collector'] {
  const v = value?.trim() || 'agent';
  if (v !== 'visual_auditor' && v !== 'runner' && v !== 'agent') throw new Error('QA_SURFACE_COLLECTOR must be visual_auditor, runner or agent');
  return v;
}

/** The evidence for one capture, or why there is none. Pure. */
export function composeSurfaceEvidence(raw: RawSurface, ctx: SurfaceContext): ComposedSurface {
  if (!ctx.commitSha || !/^[0-9a-f]{40}$/i.test(ctx.commitSha)) return { ok: false, reason: 'capture_sha_unset: set QA_CAPTURE_SHA to the full commit SHA the page was built from' };
  if (raw.found === 0) return { ok: false, reason: 'surface_not_rendered' };
  if (raw.found > 1) return { ok: false, reason: 'surface_ambiguous: more than one element carries this data-verify-surface' };
  const notes: string[] = [];
  let text: 'complete' | 'partial' = 'complete';
  let actions: 'complete' | 'partial' = 'complete';

  const blocks: SurfaceEvidence['visible']['blocks'] = [];
  for (const [i, b] of raw.blocks.entries()) {
    const role = (SURFACE_BLOCK_ROLES as readonly string[]).includes(b.role ?? '') ? (b.role as SurfaceEvidence['visible']['blocks'][number]['role']) : null;
    if (!role) { text = 'partial'; notes.push(`block ${i}: data-verify-block "${b.role ?? ''}" is not one of ${SURFACE_BLOCK_ROLES.join(', ')}`); continue; }
    if (b.nested) { text = 'partial'; notes.push(`block ${i}: contains another block, so its text is counted twice`); }
    let t = squash(b.text);
    if (!t) continue;
    if (t.length > MAX_BLOCK_TEXT) { text = 'partial'; notes.push(`block ${i}: ${t.length} characters, cut to ${MAX_BLOCK_TEXT}`); t = t.slice(0, MAX_BLOCK_TEXT); }
    if (blocks.length === MAX_BLOCKS) { text = 'partial'; notes.push(`more than ${MAX_BLOCKS} blocks; the rest are not in the capture`); break; }
    blocks.push({ id: b.id && ID.test(b.id) ? b.id : `block-${i}`, role, text: t, order: blocks.length, disclosure: b.collapsed ? 'collapsed' : 'visible' });
  }

  const acts: SurfaceEvidence['visible']['actions'] = [];
  for (const [i, a] of raw.actions.entries()) {
    if (acts.length === MAX_ACTIONS) { actions = 'partial'; notes.push(`more than ${MAX_ACTIONS} actions; the rest are not in the capture`); break; }
    const operation = (SURFACE_OPERATIONS as readonly string[]).includes(a.operation ?? '') ? (a.operation as SurfaceEvidence['visible']['actions'][number]['operation']) : 'other';
    if (operation === 'other' && a.operation !== 'other') notes.push(`action ${i}: no declared data-verify-action, recorded as other`);
    let prominence: SurfaceEvidence['visible']['actions'][number]['prominence'];
    if (a.inMenu) prominence = 'menu';
    else if (a.prominence === 'primary' || a.prominence === 'secondary') prominence = a.prominence;
    else { prominence = 'secondary'; actions = 'partial'; notes.push(`action ${i}: no data-verify-prominence`); }
    let label = squash(a.label);
    if (!label) { label = 'unlabeled'; actions = 'partial'; notes.push(`action ${i}: no visible or accessible label`); }
    acts.push({
      id: a.id && ID.test(a.id) ? a.id : `action-${i}`, label: label.slice(0, MAX_LABEL), operation, enabled: a.enabled,
      prominence, disclosure: a.collapsed ? 'collapsed' : 'visible',
    });
  }

  const facts = ctx.facts?.scenarios[ctx.scenarioId];
  if (!facts) notes.push(`no runtime facts supplied for scenario ${ctx.scenarioId}`);
  const evidence = {
    schemaVersion: 1 as const,
    subject: { commitSha: ctx.commitSha.toLowerCase(), route: ctx.route.replace(/[?#].*$/, ''), scenarioId: ctx.scenarioId, viewport: ctx.viewport },
    capture: { captureId: ctx.captureId, capturedAt: ctx.capturedAt, snapshotRef: ctx.snapshotRef },
    visible: { blocks, actions: acts },
    facts: facts ?? {},
    provenance: {
      collector: ctx.collector, collectorVersion: SURFACE_COLLECTOR_VERSION,
      reportedVia: ctx.collector === 'runner' ? 'runner' as const : 'task_token' as const,
      factVersion: facts ? ctx.facts!.factVersion : 'none',
    },
    coverage: { renderedText: text, actions, runtimeState: facts ? 'complete' as const : 'absent' as const, screenshot: ctx.screenshot ? 'complete' as const : 'absent' as const },
  };
  const parsed = parseSurfaceEvidence(evidence);
  if (!parsed.ok) return { ok: false, reason: parsed.message };
  return { ok: true, evidence: parsed.features, notes };
}

/**
 * Runs in the browser (serialized by Playwright, so self-contained): reads the
 * one `data-verify-surface` element named `surfaceId`.
 */
export function readSurfaceDom(surfaceId: string): RawSurface {
  const roots = Array.from(document.querySelectorAll('[data-verify-surface]')).filter((el) => el.getAttribute('data-verify-surface') === surfaceId);
  if (roots.length !== 1) return { found: roots.length, blocks: [], actions: [] };
  const root = roots[0]!;
  const collapsed = (el: Element) => {
    if (el.closest('[aria-hidden="true"], [hidden]')) return true;
    const check = (el as Element & { checkVisibility?: (o?: Record<string, boolean>) => boolean }).checkVisibility;
    return check ? !check.call(el, { visibilityProperty: true, opacityProperty: true }) : el.getClientRects().length === 0;
  };
  const textOf = (el: Element) => (el as HTMLElement).innerText || el.textContent || '';
  const blocks = Array.from(root.querySelectorAll('[data-verify-block]')).map((el) => ({
    id: el.getAttribute('data-verify-id'), role: el.getAttribute('data-verify-block'), text: textOf(el),
    collapsed: collapsed(el), nested: !!el.querySelector('[data-verify-block]'),
  }));
  const interactive = 'button, a[href], [role=button], [role=menuitem], [role=link], input[type=submit], input[type=button], [data-verify-action]';
  const actions = Array.from(new Set(root.querySelectorAll(interactive))).map((el) => ({
    id: el.getAttribute('data-verify-id'),
    operation: el.getAttribute('data-verify-action'),
    prominence: el.getAttribute('data-verify-prominence'),
    inMenu: !!el.closest('[role=menu]'),
    label: textOf(el) || el.getAttribute('aria-label') || (el as HTMLInputElement).value || '',
    enabled: !((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true'),
    collapsed: collapsed(el),
  }));
  return { found: 1, blocks, actions };
}
