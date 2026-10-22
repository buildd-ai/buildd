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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'design must be { kind, ref, version?, screens?: [{ id, name }] }' };
  const r = raw as Record<string, unknown>;
  // Every problem in one error, so a retry fixes them all.
  const problems: string[] = [];
  const kindOk = typeof r.kind === 'string' && (DESIGN_KINDS as readonly string[]).includes(r.kind);
  if (!kindOk) problems.push(`design.kind must be one of: ${DESIGN_KINDS.join(', ')}`);
  const kind = (kindOk ? r.kind : 'artifact') as DesignKind;
  const refOk = typeof r.ref === 'string' && !!r.ref.trim() && r.ref.length <= 500;
  if (!refOk) problems.push('design.ref is required (at most 500 characters)');
  const ref = refOk ? (r.ref as string).trim() : '';
  if (refOk && kindOk && kind === 'url' && !/^https:\/\/\S+$/.test(ref)) problems.push('design.ref must be an https URL for kind url');
  let version: string | undefined;
  if (r.version !== undefined && r.version !== null) {
    if (typeof r.version !== 'string' && typeof r.version !== 'number') problems.push('design.version must be a string or number');
    else {
      version = String(r.version).trim();
      if (!version || version.length > 100) { problems.push('design.version must be 1 to 100 characters'); version = undefined; }
    }
  }
  // Only an artifact can be versioned by its host; anything else names its version.
  if (kindOk && !version && kind !== 'artifact' && r.version === undefined) problems.push(`design.version is required for kind ${kind}: an approval binds to one version of the design`);
  if (kindOk && kind === 'artifact' && version !== undefined && !/^[1-9]\d*$/.test(version)) problems.push('design.version for an artifact is its revision number');
  let screens: DesignScreen[] | undefined;
  if (r.screens !== undefined) {
    if (!Array.isArray(r.screens) || r.screens.length > MAX_DESIGN_SCREENS) problems.push(`design.screens must be at most ${MAX_DESIGN_SCREENS} { id, name }`);
    else {
      const ids = new Set<string>();
      screens = [];
      r.screens.forEach((s, i) => {
        // A bare id string is accepted as { id, name: id }.
        const o = typeof s === 'string' ? { id: s } : s && typeof s === 'object' ? (s as Record<string, unknown>) : {};
        if (typeof o.id !== 'string' || !SCREEN_ID.test(o.id)) { problems.push(`design.screens[${i}] needs an id of letters, digits and . _ / : # - (at most 100)`); return; }
        if (ids.has(o.id)) { problems.push(`design screen ${o.id} is listed twice`); return; }
        ids.add(o.id);
        const name = typeof (o as { name?: unknown }).name === 'string' && ((o as { name: string }).name).trim() ? (o as { name: string }).name.trim().slice(0, 200) : o.id;
        screens!.push({ id: o.id, name });
      });
    }
  }
  if (problems.length) return { ok: false, error: problems.join('; ') };
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
