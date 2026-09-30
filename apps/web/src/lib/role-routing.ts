/**
 * A role's routing text (docs/design/role-routing.md §2): `whenToUse` and
 * `notFor`, stored in `workspaceSkills.metadata.routing`. They are the Choice
 * criteria of the role decision — the model reads nothing else about a role —
 * so they are validated to the §2 limits and never truncated silently.
 *
 * A role with no `whenToUse` is never a routing candidate; opting in is writing
 * the sentence.
 */

export const WHEN_TO_USE_MIN = 20;
export const WHEN_TO_USE_MAX = 300;
export const NOT_FOR_MAX = 200;

export interface RoleRouting {
  whenToUse?: string;
  notFor?: string;
  disabled?: boolean;
  updatedAt?: string;
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

/** The routing block a row's metadata carries, or null. Tolerates garbage. */
export function readRoleRouting(metadata: unknown): RoleRouting | null {
  const routing = asRecord(asRecord(metadata)?.routing);
  if (!routing) return null;
  const out: RoleRouting = {};
  if (typeof routing.whenToUse === 'string' && routing.whenToUse.trim()) out.whenToUse = routing.whenToUse.trim();
  if (typeof routing.notFor === 'string' && routing.notFor.trim()) out.notFor = routing.notFor.trim();
  if (routing.disabled === true) out.disabled = true;
  if (typeof routing.updatedAt === 'string') out.updatedAt = routing.updatedAt;
  return out;
}

/**
 * A role's routing text as one criterion string: `<whenToUse> Not for: <notFor>.`
 * (§2 "Rendered criterion").
 */
export function renderRoutingCriterion(r: { whenToUse: string; notFor?: string }): string {
  const notFor = r.notFor?.replace(/\.+$/, '');
  return notFor ? `${r.whenToUse} Not for: ${notFor}.` : r.whenToUse;
}

/**
 * `when_to_use:` from a SKILL.md frontmatter block (the Claude Code skill
 * convention), so a role written as a file opts in the same way. Only that one
 * key is read. Null when absent.
 */
export function whenToUseFromFrontmatter(content: unknown): string | null {
  if (typeof content !== 'string') return null;
  const m = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!m) return null;
  const line = /^when_to_use:[ \t]*(.*)$/m.exec(m[1]);
  if (!line) return null;
  const v = line[1].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
  return v || null;
}

/** A routing change: a string sets, null or '' clears, undefined leaves alone. */
export interface RoutingPatch {
  whenToUse?: string | null;
  notFor?: string | null;
}

export type RoutingPatchResult =
  | { ok: true; patch: RoutingPatch | null }
  | { ok: false; error: string };

/**
 * Validate `whenToUse` / `notFor` from a request body (and, when the body does
 * not state `whenToUse`, from the content's `when_to_use:` frontmatter).
 * `patch: null` means the body said nothing about routing.
 */
export function parseRoutingPatch(body: { whenToUse?: unknown; notFor?: unknown; content?: unknown }): RoutingPatchResult {
  const patch: RoutingPatch = {};
  let whenToUse = body.whenToUse;
  if (whenToUse === undefined) {
    const fm = whenToUseFromFrontmatter(body.content);
    if (fm !== null) whenToUse = fm;
  }
  if (whenToUse !== undefined) {
    if (whenToUse !== null && typeof whenToUse !== 'string') return { ok: false, error: 'whenToUse must be a string or null' };
    const v = (whenToUse ?? '').trim();
    if (v && (v.length < WHEN_TO_USE_MIN || v.length > WHEN_TO_USE_MAX)) {
      return { ok: false, error: `whenToUse must be ${WHEN_TO_USE_MIN}–${WHEN_TO_USE_MAX} characters (got ${v.length}): one or two sentences naming the work this role should pick up` };
    }
    patch.whenToUse = v || null;
  }
  if (body.notFor !== undefined) {
    if (body.notFor !== null && typeof body.notFor !== 'string') return { ok: false, error: 'notFor must be a string or null' };
    const v = (body.notFor ?? '').trim();
    if (v.length > NOT_FOR_MAX) {
      return { ok: false, error: `notFor must be at most ${NOT_FOR_MAX} characters (got ${v.length})` };
    }
    patch.notFor = v || null;
  }
  return { ok: true, patch: Object.keys(patch).length > 0 ? patch : null };
}

/**
 * `metadata` with the routing patch applied. Keeps every other metadata key
 * and a `disabled` flag; drops the `routing` key when nothing is left in it.
 */
export function applyRoutingPatch(metadata: unknown, patch: RoutingPatch, now: Date = new Date()): Record<string, unknown> {
  const meta = { ...(asRecord(metadata) ?? {}) };
  const prev = asRecord(meta.routing) ?? {};
  const next: Record<string, unknown> = { ...prev };
  for (const key of ['whenToUse', 'notFor'] as const) {
    if (patch[key] === undefined) continue;
    if (patch[key]) next[key] = patch[key];
    else delete next[key];
  }
  delete next.updatedAt;
  if (Object.keys(next).length === 0) {
    delete meta.routing;
  } else {
    meta.routing = { ...next, updatedAt: now.toISOString() };
  }
  return meta;
}
