/**
 * CBM search injection (docs/design/cbm-search-injection.md).
 *
 * After an agent's identifier search (Bash `rg`/`grep`/`git grep`, or the Grep
 * tool) returns, ask the codebase graph about the symbol, drop every location
 * the search output already showed, and append what is left to that tool's
 * result via the PostToolUse hook's `additionalContext`. The agent's command
 * is never touched.
 *
 * Everything that decides WHETHER to inject is deterministic and lives here
 * (trigger, hit parsing, the set diff, caps). The decision model only picks
 * between two lists that already exist, or neither, and is asked only when the
 * diff is non-empty. Any failure on that path injects callers (live default).
 *
 * Never throws out of the hook, never runs before the tool, and resolves
 * within `CBM_INJECTION_HOOK_BUDGET_MS`.
 *
 * Privacy: the symbol and paths live in memory only (one hook call, plus the
 * per-session dedupe set and the uptake digests). The persisted block
 * (`CbmInjectionMetrics`) carries counts and labels.
 */
import { createHash } from 'crypto';
import { isAbsolute, relative } from 'path';
import type { HookCallback } from '@anthropic-ai/claude-agent-sdk';
import {
  CBM_INJECTION_MAX_EVENTS,
  CBM_INJECTION_MAX_PER_SESSION,
  CBM_INJECTION_MIN_SYMBOL_LENGTH,
  CBM_INJECTION_UPTAKE_WINDOW,
  INJECTED_OUTCOMES,
  NON_EMPTY_DIFF_OUTCOMES,
  emptyCbmInjectionMetrics,
  type CbmInjectionAction,
  type CbmInjectionDecisionReply,
  type CbmInjectionEvent,
  type CbmInjectionFacts,
  type CbmInjectionJevRecord,
  type CbmInjectionMetrics,
  type CbmInjectionOutcome,
  type CbmInjectionTrigger,
} from '@buildd/core/cbm-injection';
import { classifyBashSearch, shapeOfSearchPattern } from './bash-classify';
import type { CbmGraph, GraphAnswer, GraphLocation } from './cbm-graph-client';

/** Whole hook, hard. */
export const CBM_INJECTION_HOOK_BUDGET_MS = 1500;
/** Graph lookups (both depths together). */
export const CBM_INJECTION_GRAPH_BUDGET_MS = 450;
/** Decision round trip, as the runner sees it. */
export const CBM_INJECTION_DECIDE_BUDGET_MS = 1000;
/** Entries listed in one note; the rest is a count. */
export const CBM_INJECTION_MAX_ENTRIES = 8;
/** ~300 tokens. */
export const CBM_INJECTION_MAX_CHARS = 1200;
/** `inject_impact` depth. */
export const CBM_INJECTION_IMPACT_DEPTH = 3;

const IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The off switch: `BUILDD_CBM_INJECTION=0|false|off|no`. Default on. */
export function isCbmInjectionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = (env.BUILDD_CBM_INJECTION ?? '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no', 'disabled'].includes(v);
}

// ── Trigger ──────────────────────────────────────────────────────────────────

/** A symbol worth a graph lookup: identifier-shaped and not too short to mean anything. */
export function isTriggerSymbol(symbol: string | null | undefined): symbol is string {
  return typeof symbol === 'string'
    && symbol.length >= CBM_INJECTION_MIN_SYMBOL_LENGTH
    && IDENTIFIER_RE.test(symbol);
}

/**
 * Does this tool call trigger a lookup, and for which symbol? Bash goes through
 * the classifier (`code_search` + `identifier`); Grep through the same pattern
 * shape rule. Every other tool, shape and bucket: null.
 */
export function detectTrigger(toolName: string, toolInput: unknown): { trigger: CbmInjectionTrigger; symbol: string } | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  if (toolName === 'Bash') {
    if (typeof input.command !== 'string') return null;
    const { classification, identifier } = classifyBashSearch(input.command);
    if (classification.bucket !== 'code_search' || classification.searchShape !== 'identifier') return null;
    return isTriggerSymbol(identifier) ? { trigger: 'bash', symbol: identifier } : null;
  }
  if (toolName === 'Grep') {
    if (typeof input.pattern !== 'string') return null;
    if (shapeOfSearchPattern(input.pattern) !== 'identifier') return null;
    const symbol = input.pattern.trim();
    return isTriggerSymbol(symbol) ? { trigger: 'grep', symbol } : null;
  }
  return null;
}

// ── Search output → hits ─────────────────────────────────────────────────────

export interface SearchHit {
  /** As printed, normalised (no `./`, worktree prefix stripped). */
  path: string;
  /** Null when the output names the file but no line (`rg -l`, no `-n`). */
  line: number | null;
}

/**
 * The text a search tool returned. Bash: stdout. Grep tool: its content and/or
 * filename list (the response is structured, and its shape varies by mode).
 */
export function extractToolOutputText(toolName: string, toolResponse: unknown): string {
  if (typeof toolResponse === 'string') return toolResponse;
  if (!toolResponse || typeof toolResponse !== 'object') return '';
  const r = toolResponse as Record<string, unknown>;
  const parts: string[] = [];
  if (toolName === 'Bash') {
    if (typeof r.stdout === 'string') parts.push(r.stdout);
    return parts.join('\n');
  }
  if (typeof r.content === 'string') parts.push(r.content);
  if (Array.isArray(r.filenames)) parts.push(r.filenames.filter(f => typeof f === 'string').join('\n'));
  if (typeof r.output === 'string') parts.push(r.output);
  return parts.join('\n');
}

const ANSI_RE = /\x1b\[[0-9;]*m/g;
/** `path:12:text` (match) or `path:12-text` (context). */
const LINE_HIT_RE = /^([^\s:][^:]*?):(\d+)[:-]/;
/** `path:text` or `path` alone (no line numbers). The path must look like a file. */
const FILE_HIT_RE = /^([^\s:][^:\s]*\.[A-Za-z0-9_]+)(?::|$)/;
/** rg --heading body line: `12:text` / `12-text` under a path line. */
const HEADING_LINE_RE = /^(\d+)[:-]/;

function normalizeHitPath(raw: string, worktreePath: string): string {
  let p = raw.trim();
  if (isAbsolute(p) && worktreePath) {
    const rel = relative(worktreePath, p);
    if (!rel.startsWith('..') && !isAbsolute(rel)) p = rel;
  }
  while (p.startsWith('./')) p = p.slice(2);
  return p;
}

/** Parse grep/rg/git-grep/Grep-tool output into file:line hits. Bounded at 5,000 lines. */
export function parseSearchHits(text: string, worktreePath: string): SearchHit[] {
  const hits: SearchHit[] = [];
  let heading: string | null = null;
  const lines = text.replace(ANSI_RE, '').split('\n').slice(0, 5000);
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line) { heading = null; continue; }
    if (heading) {
      const h = HEADING_LINE_RE.exec(line);
      if (h) { hits.push({ path: heading, line: Number(h[1]) }); continue; }
    }
    const m = LINE_HIT_RE.exec(line);
    if (m && !m[1].includes('://')) {
      hits.push({ path: normalizeHitPath(m[1], worktreePath), line: Number(m[2]) });
      continue;
    }
    const f = FILE_HIT_RE.exec(line);
    if (f && !f[1].includes('://')) {
      const path = normalizeHitPath(f[1], worktreePath);
      hits.push({ path, line: null });
      // A bare path line may be an rg --heading header for the lines below it.
      heading = line === f[1] ? path : null;
      continue;
    }
    heading = null;
  }
  return hits;
}

/**
 * Same file? Exact, or one is a path-segment suffix of the other — so a search
 * run from a subdirectory (`src/x.ts`) still matches the graph's repo-relative
 * `apps/a/src/x.ts`.
 */
export function pathsMatch(hitPath: string, graphPath: string): boolean {
  if (!hitPath || !graphPath) return false;
  if (hitPath === graphPath) return true;
  return graphPath.endsWith(`/${hitPath}`) || hitPath.endsWith(`/${graphPath}`);
}

/**
 * The locations the search did not show. A hit covers a location when it names
 * the same file and either has no line (file-level) or a line inside the
 * location's range. File-level hits cover the whole file: the diff errs toward
 * silence.
 */
export function diffGraphAgainstHits(locations: GraphLocation[], hits: SearchHit[]): GraphLocation[] {
  return locations.filter(loc => !hits.some(h =>
    pathsMatch(h.path, loc.path) && (h.line === null || (h.line >= loc.startLine && h.line <= loc.endLine)),
  ));
}

/** Unique, ordered: definitions, then callers by hop, then path. */
function orderLocations(locs: GraphLocation[]): GraphLocation[] {
  const seen = new Set<string>();
  const out: GraphLocation[] = [];
  const sorted = [...locs].sort((a, b) => {
    if (a.relation !== b.relation) return a.relation === 'definition' ? -1 : 1;
    if ((a.hop ?? 0) !== (b.hop ?? 0)) return (a.hop ?? 0) - (b.hop ?? 0);
    return a.path === b.path ? a.startLine - b.startLine : a.path < b.path ? -1 : 1;
  });
  for (const l of sorted) {
    const key = `${l.path}:${l.startLine}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/** The note the agent reads. ≤ CBM_INJECTION_MAX_CHARS, ≤ CBM_INJECTION_MAX_ENTRIES entries. */
export function formatInjection(symbol: string, missed: GraphLocation[], mode: 'callers' | 'impact'): { text: string; injectedCount: number; locations: GraphLocation[] } {
  const ordered = orderLocations(missed);
  const header = `[buildd code graph] ${ordered.length} location${ordered.length === 1 ? '' : 's'} for \`${symbol}\` that this search did not show:`;
  const footer = 'mcp__codebase-memory__trace_path gives the full call chain.';
  const lines: string[] = [];
  const shown: GraphLocation[] = [];
  let length = header.length + footer.length + 40;
  for (const loc of ordered) {
    if (shown.length >= CBM_INJECTION_MAX_ENTRIES) break;
    const relation = loc.relation === 'definition'
      ? `definition${loc.label ? `, ${loc.label}` : ''}`
      : `caller: ${loc.name}${mode === 'impact' && (loc.hop ?? 1) > 1 ? `, ${loc.hop} hops` : ''}`;
    const entry = `- ${loc.path}:${loc.startLine} (${relation})`;
    if (length + entry.length + 1 > CBM_INJECTION_MAX_CHARS) break;
    lines.push(entry);
    shown.push(loc);
    length += entry.length + 1;
  }
  const rest = ordered.length - shown.length;
  if (rest > 0) lines.push(`… and ${rest} more`);
  return { text: [header, ...lines, footer].join('\n'), injectedCount: shown.length, locations: shown };
}

// ── Manifest match ───────────────────────────────────────────────────────────

function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') i++; }
      else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Is a repo-relative path inside a declared manifest (exact, directory prefix, or glob)? */
export function inManifest(path: string, manifest: readonly string[] | null | undefined): boolean {
  if (!manifest?.length) return false;
  return manifest.some(entry => {
    const e = entry.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!e) return false;
    if (/[*?]/.test(e)) return globToRegExp(e).test(path);
    return path === e || path.startsWith(`${e}/`);
  });
}

// ── The injector ─────────────────────────────────────────────────────────────

export interface CbmInjectorDeps {
  /** Null when the graph client could not be created: every trigger is `no_index`. */
  graph: CbmGraph | null;
  /** The decision route. Must never throw; the injector also guards it. */
  decide: (facts: CbmInjectionFacts, timeoutMs: number) => Promise<CbmInjectionDecisionReply>;
  worktreePath: string;
  task: { kind?: string | null; category?: string | null; pathManifest?: string[] | null };
  now?: () => number;
}

interface UptakeWindow { digests: Set<string>; remaining: number }

const UPTAKE_TOOLS = new Set(['Read', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

function digest(path: string): string {
  return createHash('sha256').update(path).digest('hex').slice(0, 16);
}

interface Evaluation {
  outcome: CbmInjectionOutcome;
  hitCount: number;
  hitFiles: number;
  graphCount: number;
  diffSize: number;
  symbolKind: string | null;
  jev?: CbmInjectionJevRecord;
  text?: string;
  injectedCount: number;
  injectedPaths?: string[];
}

export class CbmInjector {
  private readonly metrics: CbmInjectionMetrics = emptyCbmInjectionMetrics(true);
  private readonly seenSymbols = new Set<string>();
  // Slots held by in-flight evaluations: parallel searches must not all pass the cap before any records.
  private pendingInjections = 0;
  private readonly editedPaths = new Set<string>();
  private readonly uptake: UptakeWindow[] = [];
  private readonly now: () => number;

  constructor(private readonly deps: CbmInjectorDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** The block for `resultMeta.cbm.injection`. A copy. */
  snapshot(): CbmInjectionMetrics {
    return {
      ...this.metrics,
      byOutcome: { ...this.metrics.byOutcome },
      uptake: { ...this.metrics.uptake },
      events: this.metrics.events.map(e => ({ ...e, ...(e.jev ? { jev: { ...e.jev } } : {}) })),
    };
  }

  private record(trigger: CbmInjectionTrigger, ev: Evaluation, latencyMs: number): void {
    const m = this.metrics;
    m.triggers++;
    m.byOutcome[ev.outcome] = (m.byOutcome[ev.outcome] ?? 0) + 1;
    if (INJECTED_OUTCOMES.has(ev.outcome)) m.injections++;
    if (NON_EMPTY_DIFF_OUTCOMES.has(ev.outcome)) m.nonEmptyDiff++;
    if (ev.graphCount > 0) m.graphAnswered++;
    const event: CbmInjectionEvent = {
      trigger,
      outcome: ev.outcome,
      hitCount: ev.hitCount,
      hitFiles: ev.hitFiles,
      graphCount: ev.graphCount,
      diffSize: ev.diffSize,
      injectedCount: ev.injectedCount,
      symbolKind: ev.symbolKind,
      latencyMs,
      ...(ev.jev ? { jev: ev.jev } : {}),
    };
    if (m.events.length < CBM_INJECTION_MAX_EVENTS) m.events.push(event);
    else m.eventsDropped++;
  }

  /**
   * One PostToolUse. Returns the note to append, or null. Never throws, and
   * resolves within the hook budget whatever the graph or network does.
   */
  async handlePostToolUse(toolName: string, toolInput: unknown, toolResponse: unknown): Promise<string | null> {
    let detected: ReturnType<typeof detectTrigger>;
    try { detected = detectTrigger(toolName, toolInput); } catch { return null; }
    if (!detected) return null;
    const { trigger, symbol } = detected;
    const started = this.now();

    const zero = { hitCount: 0, hitFiles: 0, graphCount: 0, diffSize: 0, symbolKind: null, injectedCount: 0 };
    if (this.metrics.injections + this.pendingInjections >= CBM_INJECTION_MAX_PER_SESSION) {
      this.record(trigger, { ...zero, outcome: 'cap_reached' }, this.now() - started);
      return null;
    }
    if (this.seenSymbols.has(symbol)) {
      this.record(trigger, { ...zero, outcome: 'repeat_symbol' }, this.now() - started);
      return null;
    }
    this.seenSymbols.add(symbol);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<'deadline'>(resolve => { timer = setTimeout(() => resolve('deadline'), CBM_INJECTION_HOOK_BUDGET_MS); });
    let ev: Evaluation | 'deadline';
    this.pendingInjections++;
    try {
      ev = await Promise.race([
        this.evaluate(trigger, symbol, toolName, toolResponse).catch((): Evaluation => ({ ...zero, outcome: 'no_index' })),
        deadline,
      ]);
    } finally {
      clearTimeout(timer);
      this.pendingInjections--;
    }
    if (ev === 'deadline') {
      this.record(trigger, { ...zero, outcome: 'deadline_exceeded' }, this.now() - started);
      return null;
    }
    // A graph that was not ready said nothing about this symbol; let a later
    // search for it be evaluated once the index has landed.
    if (ev.outcome === 'no_index') this.seenSymbols.delete(symbol);
    this.record(trigger, ev, this.now() - started);
    if (!ev.text || !ev.injectedPaths?.length) return ev.text ?? null;
    this.uptake.push({ digests: new Set(ev.injectedPaths.map(digest)), remaining: CBM_INJECTION_UPTAKE_WINDOW });
    this.metrics.uptake.tracked++;
    return ev.text;
  }

  private async evaluate(trigger: CbmInjectionTrigger, symbol: string, toolName: string, toolResponse: unknown): Promise<Evaluation> {
    const hits = parseSearchHits(extractToolOutputText(toolName, toolResponse), this.deps.worktreePath);
    const hitFiles = new Set(hits.map(h => h.path)).size;
    const base = { hitCount: hits.length, hitFiles, graphCount: 0, diffSize: 0, symbolKind: null as string | null, injectedCount: 0 };

    const graph = this.deps.graph;
    if (!graph || !(await graph.isReady())) return { ...base, outcome: 'no_index' };

    const graphStarted = this.now();
    let answer: GraphAnswer | null;
    try {
      answer = await graph.lookup(symbol, { depth: 1, timeoutMs: CBM_INJECTION_GRAPH_BUDGET_MS });
    } catch {
      return { ...base, outcome: 'no_index' };
    }
    if (!answer) return { ...base, outcome: 'not_in_graph' };

    const symbolKind = answer.definitions[0]?.label ?? null;
    const direct = [...answer.definitions, ...answer.callers];
    const missed = diffGraphAgainstHits(direct, hits);
    const withGraph = { ...base, graphCount: direct.length, diffSize: missed.length, symbolKind };
    if (missed.length === 0) return { ...withGraph, outcome: 'empty_diff' };

    const facts: CbmInjectionFacts = {
      trigger,
      taskKind: this.deps.task.kind ?? null,
      taskCategory: this.deps.task.category ?? null,
      missedInManifest: missed.some(l => inManifest(l.path, this.deps.task.pathManifest)),
      missedAlreadyEdited: missed.some(l => [...this.editedPaths].some(p => pathsMatch(p, l.path))),
      hitCount: hits.length,
      hitFiles,
      definitionCount: answer.definitions.length,
      callerCount: answer.callers.length,
      diffSize: missed.length,
      definitionMissed: missed.some(l => l.relation === 'definition'),
      symbolKind: symbolKind && /^[A-Za-z][A-Za-z0-9_-]{0,39}$/.test(symbolKind) ? symbolKind : null,
    };

    const decideStarted = this.now();
    let reply: CbmInjectionDecisionReply;
    try {
      reply = await this.deps.decide(facts, CBM_INJECTION_DECIDE_BUDGET_MS);
    } catch {
      reply = { ok: false, error: 'transport', latencyMs: this.now() - decideStarted, version: null };
    }
    const jev: CbmInjectionJevRecord = reply.ok
      ? { label: reply.label, confidence: reply.confidence, status: reply.status, latencyMs: this.now() - decideStarted, version: reply.version }
      : { label: null, confidence: null, status: 'error', latencyMs: this.now() - decideStarted, version: reply.version, error: reply.error.slice(0, 40) };

    const action: CbmInjectionAction = reply.ok ? reply.action : 'inject_callers';
    if (action === 'skip') return { ...withGraph, outcome: 'jev_skip', jev };
    const fallback = !reply.ok || reply.status === 'below_threshold';

    let shown = missed;
    let mode: 'callers' | 'impact' = 'callers';
    if (action === 'inject_impact' && !fallback) {
      const left = CBM_INJECTION_GRAPH_BUDGET_MS - (this.now() - graphStarted);
      try {
        const wide = left > 50 ? await graph.lookup(symbol, { depth: CBM_INJECTION_IMPACT_DEPTH, timeoutMs: Math.max(50, left) }) : null;
        if (wide) {
          const wideMissed = diffGraphAgainstHits([...wide.definitions, ...wide.callers], hits);
          if (wideMissed.length > 0) { shown = wideMissed; mode = 'impact'; }
        }
      } catch {
        // The direct diff stands.
      }
    }
    const note = formatInjection(symbol, shown, mode);
    const outcome: CbmInjectionOutcome = fallback ? 'jev_error_injected' : mode === 'impact' ? 'injected_impact' : 'injected_callers';
    return {
      ...withGraph,
      outcome,
      jev,
      text: note.text,
      injectedCount: note.injectedCount,
      injectedPaths: note.locations.map(l => l.path),
    };
  }

  /**
   * Every tool_use, in order (handleMessage). Feeds the uptake windows and the
   * already-edited set. Counts only leave the process.
   */
  observeToolCall(toolName: string, input: unknown): void {
    const filePath = (input as { file_path?: unknown; notebook_path?: unknown } | null)?.file_path
      ?? (input as { notebook_path?: unknown } | null)?.notebook_path;
    const rel = typeof filePath === 'string' ? normalizeHitPath(filePath, this.deps.worktreePath) : null;
    if (rel && EDIT_TOOLS.has(toolName)) this.editedPaths.add(rel);
    if (this.uptake.length === 0) return;
    const d = rel && UPTAKE_TOOLS.has(toolName) ? digest(rel) : null;
    for (let i = this.uptake.length - 1; i >= 0; i--) {
      const w = this.uptake[i];
      if (d && w.digests.has(d)) {
        this.metrics.uptake.taken++;
        this.uptake.splice(i, 1);
        continue;
      }
      w.remaining--;
      if (w.remaining <= 0) this.uptake.splice(i, 1);
    }
  }
}

/**
 * Codex has no post-tool seam. Its identifier searches are counted as
 * `unsupported_backend` so the readout can size the gap; nothing is queried.
 */
export function recordUnsupportedTrigger(metrics: CbmInjectionMetrics, toolName: string, toolInput: unknown): void {
  let detected: ReturnType<typeof detectTrigger>;
  try { detected = detectTrigger(toolName, toolInput); } catch { return; }
  if (!detected) return;
  metrics.triggers++;
  metrics.byOutcome.unsupported_backend = (metrics.byOutcome.unsupported_backend ?? 0) + 1;
  const event: CbmInjectionEvent = {
    trigger: detected.trigger, outcome: 'unsupported_backend',
    hitCount: 0, hitFiles: 0, graphCount: 0, diffSize: 0, injectedCount: 0, symbolKind: null, latencyMs: 0,
  };
  if (metrics.events.length < CBM_INJECTION_MAX_EVENTS) metrics.events.push(event);
  else metrics.eventsDropped++;
}

/** The PostToolUse hook. Observational except for the appended note; never throws. */
export function createCbmInjectionHook(injector: CbmInjector): HookCallback {
  return async (input) => {
    const i = input as { hook_event_name?: string; tool_name?: string; tool_input?: unknown; tool_response?: unknown };
    if (i.hook_event_name !== 'PostToolUse' || typeof i.tool_name !== 'string') return {};
    try {
      const text = await injector.handlePostToolUse(i.tool_name, i.tool_input, i.tool_response);
      return text
        ? { hookSpecificOutput: { hookEventName: 'PostToolUse' as const, additionalContext: text } }
        : {};
    } catch {
      return {};
    }
  };
}
