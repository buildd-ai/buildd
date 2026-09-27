/**
 * `@builddai/ai-kit/chat/server`: tool permissions and (from P3) the turn runner.
 *
 * P0 ships the tool-permission primitive for real: `defineToolGroups` and the
 * pure enforcement function `skipCardVerdict` / `canSkipCard`. It is the rule
 * set buildd's chat enforces today, ported without re-deriving it:
 *
 * An Allowed write skips its approval card only when ALL of these hold:
 *  - the person set the tool's group to Allow, and the group is toggleable;
 *  - the call's effective class is `write` (never `read`, never `admin`);
 *  - it starts no recurring or unattended work, and it does not spend;
 *  - its input carries only fields the app marked safe to skip on;
 *  - nothing a tool returned is in the model's context (the anti-injection
 *    taint rule: `contentInContext` / `toolOutputInHistory`);
 *  - no docked object's data is in the instructions;
 *  - it is the first skipped write of the turn.
 * The caller must then still build the same server-side preview a card would,
 * and skip only if it resolves. The skip removes the tap, not the checks.
 *
 * `createChatTurn` is typed here as a skeleton; its implementation lands in P3.
 */

import type { ToolPermissionMode, ToolPermissionRow } from '@builddai/ai-kit/chat/contract';

// ── Taint ─────────────────────────────────────────────────────────────────────

/** The structural subset of an AI SDK `ModelMessage` the taint check reads. */
export interface TaintMessage {
  role: string;
  content: unknown;
}

/** Is anything a tool returned in the messages the model is reading? */
export function contentInContext(messages: readonly TaintMessage[]): boolean {
  return messages.some(m => m.role === 'tool'
    || (Array.isArray(m.content) && (m.content as Array<{ type?: string }>).some(p => p?.type === 'tool-result')));
}

/**
 * Did a tool ever return anything in this conversation? Sticky: once tool
 * output was read, later assistant text may repeat it after the tool part
 * itself has left the model's window. `truncated` (the load hit its limit, so
 * older rows are unseen) counts as yes.
 */
export function toolOutputInHistory(rows: ReadonlyArray<{ parts: ReadonlyArray<{ type?: string }> }>, truncated: boolean): boolean {
  if (truncated) return true;
  return rows.some(m => m.parts.some(p => typeof p?.type === 'string' && (p.type.startsWith('tool-') || p.type === 'dynamic-tool')));
}

// ── Enforcement (pure) ────────────────────────────────────────────────────────

export type ToolCallClass = 'read' | 'write' | 'admin';

/** Everything the skip decision needs, already resolved by the caller. */
export interface SkipCardFacts {
  /**
   * The call's effective class, or undefined for a tool the app doesn't know.
   * Only `'write'` can skip; any other class an app uses (`'admin'`, `'read'`,
   * or its own, e.g. a deferred op) asks.
   */
  callClass: ToolCallClass | (string & {}) | undefined;
  /** The group the tool belongs to, or undefined. */
  group: string | undefined;
  /** Can this group be set to Allow at all (a toggleable group with a write)? */
  groupAllowable: boolean;
  /** Groups this person set to Allow. */
  allowedGroups: ReadonlySet<string>;
  /** Tool output in the model's context (history or this turn). */
  tainted: boolean;
  /** An object is docked: its data is in the instructions. */
  docked: boolean;
  /** Starts recurring or unattended work (schedules, arming, resuming). */
  startsUnattendedWork: boolean;
  /** Spends money on its own (files a runner job, buys something). */
  spends?: boolean;
  /** The input carries only fields the app marked safe to skip on. Default true. */
  inputSkippable?: boolean;
  /** Writes already run without a card in this turn. */
  skippedThisTurn: number;
}

export type SkipCardReason =
  | 'tainted'
  | 'docked'
  | 'nothing_allowed'
  | 'already_skipped_this_turn'
  | 'unknown_tool'
  | 'not_write'
  | 'unattended'
  | 'spends'
  | 'input_not_skippable'
  | 'group_not_allowed';

export type SkipCardVerdict = { skip: true } | { skip: false; reason: SkipCardReason };

/** May this call run without its card? The first failing rule is the reason. */
export function skipCardVerdict(f: SkipCardFacts): SkipCardVerdict {
  const no = (reason: SkipCardReason): SkipCardVerdict => ({ skip: false, reason });
  if (f.tainted) return no('tainted');
  if (f.docked) return no('docked');
  if (f.allowedGroups.size === 0) return no('nothing_allowed');
  if (f.skippedThisTurn > 0) return no('already_skipped_this_turn');
  if (f.callClass === undefined || f.group === undefined) return no('unknown_tool');
  if (f.callClass !== 'write') return no('not_write');
  if (f.startsUnattendedWork) return no('unattended');
  if (f.spends) return no('spends');
  if (f.inputSkippable === false) return no('input_not_skippable');
  if (!f.groupAllowable || !f.allowedGroups.has(f.group)) return no('group_not_allowed');
  return { skip: true };
}

export function canSkipCard(f: SkipCardFacts): boolean {
  return skipCardVerdict(f).skip;
}

// ── Declaring tool groups ─────────────────────────────────────────────────────

/** A per-call predicate or a constant. */
type ByInput<T> = T | ((input: unknown) => T);

/** What the kit needs to know about one tool. The tool itself stays the app's. */
export interface KitToolDecl {
  /** The name the model calls it by (the UI part type is `tool-{name}`). */
  name: string;
  /** Base class. `effectiveClass` may raise it per call (a budget field makes it admin). */
  class: ToolCallClass;
  effectiveClass?: (input: unknown) => ToolCallClass;
  startsUnattendedWork?: ByInput<boolean>;
  spends?: ByInput<boolean>;
  /** Fields a skipped card may carry. Absent = any. An allowlist, so a new field asks. */
  skippableFields?: readonly string[];
}

export type ToolGroupDecl =
  | { label: string; tools?: readonly KitToolDecl[]; modes: readonly ('ask' | 'allow')[]; fixed?: never }
  | { label: string; tools?: readonly KitToolDecl[]; fixed: 'ask' | 'read' | 'never'; modes?: never };

export interface ToolGroups<G extends string> {
  readonly keys: readonly G[];
  /** Groups a person may set to Allow. */
  readonly allowable: readonly G[];
  /** Stored or requested list → the groups that may be allowed. Drops anything else. */
  parseAllowed(raw: unknown): ReadonlySet<G>;
  /** One row per group for the tools menu. */
  rows(allowed: ReadonlySet<string>): ToolPermissionRow[];
  /** The tool's group, or undefined. */
  groupOf(tool: string): G | undefined;
  tool(name: string): KitToolDecl | undefined;
  /** Tool names that may be registered with the model. A `never` group contributes none. */
  registeredToolNames(): string[];
  /** The facts for one call, resolved from the declaration. */
  facts(args: CallArgs): SkipCardFacts;
  skipCardVerdict(args: CallArgs): SkipCardVerdict;
  canSkipCard(args: CallArgs): boolean;
}

export interface CallArgs {
  tool: string;
  input: unknown;
  allowedGroups: ReadonlySet<string>;
  tainted: boolean;
  docked: boolean;
  skippedThisTurn: number;
}

export class ToolGroupsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolGroupsError';
  }
}

const resolve = <T>(v: ByInput<T> | undefined, input: unknown, dflt: T): T =>
  v === undefined ? dflt : typeof v === 'function' ? (v as (i: unknown) => T)(input) : v;

/**
 * Declare an app's tool groups once. The same declaration drives the menu
 * rows, the per-person preference and server-side enforcement.
 *
 * Throws at startup (a `ToolGroupsError`) when the declaration is unsafe:
 * a group with both or neither of `modes` / `fixed`, a `read` group holding a
 * write, a `never` group holding tools, a toggleable group without a write,
 * or one tool in two groups. Every toggleable group defaults to `ask`.
 */
export function defineToolGroups<const D extends Record<string, ToolGroupDecl>>(decl: D): ToolGroups<keyof D & string> {
  type G = keyof D & string;
  const keys = Object.keys(decl) as G[];
  const byTool = new Map<string, { group: G; tool: KitToolDecl }>();
  const allowable: G[] = [];

  for (const key of keys) {
    const g = decl[key] as ToolGroupDecl & { modes?: readonly string[]; fixed?: string };
    const hasModes = Array.isArray(g.modes);
    const hasFixed = typeof g.fixed === 'string';
    if (hasModes === hasFixed) throw new ToolGroupsError(`group '${key}' must declare exactly one of 'modes' or 'fixed'`);
    const tools = g.tools ?? [];
    if (g.fixed === 'never' && tools.length > 0) {
      throw new ToolGroupsError(`group '${key}' is 'never' but lists tools; a never group is not a tool at all`);
    }
    if (g.fixed === 'read') {
      const w = tools.find(t => t.class !== 'read');
      if (w) throw new ToolGroupsError(`group '${key}' is read only but '${w.name}' is class '${w.class}'`);
    }
    if (hasModes) {
      const modes = g.modes as readonly string[];
      if (!modes.includes('ask') || modes.some(m => m !== 'ask' && m !== 'allow')) {
        throw new ToolGroupsError(`group '${key}' modes must include 'ask' and contain only 'ask' / 'allow'`);
      }
      if (!tools.some(t => t.class === 'write')) {
        throw new ToolGroupsError(`group '${key}' is toggleable but has no write tool; declare it fixed: 'read'`);
      }
      if (modes.includes('allow')) allowable.push(key);
    }
    for (const t of tools) {
      const prior = byTool.get(t.name);
      if (prior) throw new ToolGroupsError(`tool '${t.name}' is in both '${prior.group}' and '${key}'`);
      byTool.set(t.name, { group: key, tool: t });
    }
  }

  const allowableSet = new Set<string>(allowable);

  const facts = (a: CallArgs): SkipCardFacts => {
    const hit = byTool.get(a.tool);
    const t = hit?.tool;
    const callClass = t ? (t.effectiveClass ? t.effectiveClass(a.input) : t.class) : undefined;
    const i = (a.input && typeof a.input === 'object' ? a.input : {}) as Record<string, unknown>;
    const fields = t?.skippableFields ? new Set(t.skippableFields) : null;
    return {
      callClass,
      group: hit?.group,
      groupAllowable: !!hit && allowableSet.has(hit.group),
      allowedGroups: a.allowedGroups,
      tainted: a.tainted,
      docked: a.docked,
      startsUnattendedWork: t ? resolve(t.startsUnattendedWork, a.input, false) : false,
      spends: t ? resolve(t.spends, a.input, false) : false,
      inputSkippable: fields ? Object.keys(i).every(k => i[k] === undefined || fields.has(k)) : true,
      skippedThisTurn: a.skippedThisTurn,
    };
  };

  return {
    keys,
    allowable,
    parseAllowed(raw) {
      const out = new Set<G>();
      if (!Array.isArray(raw)) return out;
      for (const g of raw) if (typeof g === 'string' && allowableSet.has(g)) out.add(g as G);
      return out;
    },
    rows(allowed) {
      return keys.map((key): ToolPermissionRow => {
        const g = decl[key];
        if (g.fixed) return { key, label: g.label, mode: g.fixed as ToolPermissionMode, locked: true };
        return { key, label: g.label, mode: allowableSet.has(key) && allowed.has(key) ? 'allow' : 'ask', locked: false };
      });
    },
    groupOf: tool => byTool.get(tool)?.group,
    tool: name => byTool.get(name)?.tool,
    registeredToolNames: () => [...byTool.keys()],
    facts,
    skipCardVerdict: a => skipCardVerdict(facts(a)),
    canSkipCard: a => canSkipCard(facts(a)),
  };
}

// ── Turn runner (skeleton; implemented in P3) ─────────────────────────────────

/**
 * The options `createChatTurn` will take. Declared now so consumers can shape
 * their adapters against it; the runner itself ships in P3.
 */
export interface ChatTurnOptions<G extends string = string> {
  /** Resolve the provider key that pays for this person's turn; null ⇒ `409 no_key`. */
  key: (userId: string) => Promise<string | null> | string | null;
  groups: ToolGroups<G>;
  /** The app's dry run, used by approval cards and by Allow. */
  preview: (tool: string, input: Record<string, unknown>) => Promise<{ ok: true; preview: unknown } | { ok: false; message: string }>;
  limits?: { maxSteps?: number; turnMs?: number };
}
