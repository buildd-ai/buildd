import { DESIGN_KINDS, type DesignKind, type DesignRef, type DesignScreen } from './shapes';

/**
 * A revision's design reference (D-8, D-9): the design the text is built to,
 * at one version. Pure validation of the shape; a host checks that the thing
 * it names exists (an artifact in the workspace, at that revision).
 */

export const MAX_DESIGN_SCREENS = 50;
const SCREEN_ID = /^[A-Za-z0-9._/:#-]{1,100}$/;

export type DesignParse = { ok: true; design: DesignRef } | { ok: false; error: string };

export function parseDesignRef(raw: unknown): DesignParse {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'design must be { kind, ref, version?, screens? }' };
  const r = raw as Record<string, unknown>;
  if (typeof r.kind !== 'string' || !(DESIGN_KINDS as readonly string[]).includes(r.kind)) {
    return { ok: false, error: `design.kind must be one of: ${DESIGN_KINDS.join(', ')}` };
  }
  const kind = r.kind as DesignKind;
  if (typeof r.ref !== 'string' || !r.ref.trim() || r.ref.length > 500) return { ok: false, error: 'design.ref is required (at most 500 characters)' };
  const ref = r.ref.trim();
  if (kind === 'url' && !/^https:\/\/\S+$/.test(ref)) return { ok: false, error: 'design.ref must be an https URL for kind url' };
  let version: string | undefined;
  if (r.version !== undefined && r.version !== null) {
    if (typeof r.version !== 'string' && typeof r.version !== 'number') return { ok: false, error: 'design.version must be a string or number' };
    version = String(r.version).trim();
    if (!version || version.length > 100) return { ok: false, error: 'design.version must be 1 to 100 characters' };
  }
  // Only an artifact can be versioned by its host; anything else names its version.
  if (!version && kind !== 'artifact') return { ok: false, error: `design.version is required for kind ${kind}: an approval binds to one version of the design` };
  if (kind === 'artifact' && version !== undefined && !/^[1-9]\d*$/.test(version)) return { ok: false, error: 'design.version for an artifact is its revision number' };
  let screens: DesignScreen[] | undefined;
  if (r.screens !== undefined) {
    if (!Array.isArray(r.screens) || r.screens.length > MAX_DESIGN_SCREENS) return { ok: false, error: `design.screens must be at most ${MAX_DESIGN_SCREENS} { id, name }` };
    const ids = new Set<string>();
    screens = [];
    for (const s of r.screens) {
      const o = s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
      if (typeof o.id !== 'string' || !SCREEN_ID.test(o.id)) return { ok: false, error: 'each design screen needs an id of letters, digits and . _ / : # - (at most 100)' };
      if (ids.has(o.id)) return { ok: false, error: `design screen ${o.id} is listed twice` };
      ids.add(o.id);
      const name = typeof o.name === 'string' && o.name.trim() ? o.name.trim().slice(0, 200) : o.id;
      screens.push({ id: o.id, name });
    }
  }
  return { ok: true, design: { kind, ref, ...(version ? { version } : {}), ...(screens ? { screens } : {}) } as DesignRef };
}

/** Same design at the same version, for "did this revise change the design". */
export function sameDesign(a: DesignRef | null | undefined, b: DesignRef | null | undefined): boolean {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/**
 * Has the design moved past the version an approval recorded? Known only when
 * the host can read the design's current version; null means it cannot tell.
 */
export function designDrift(approved: DesignRef | null | undefined, currentVersion: string | null): { pinned: string; current: string } | null {
  if (!approved?.version || currentVersion === null) return null;
  return currentVersion !== approved.version ? { pinned: approved.version, current: currentVersion } : null;
}
