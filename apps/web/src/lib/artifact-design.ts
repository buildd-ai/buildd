/**
 * A design is a file artifact (an HTML export, a prototype, images) whose
 * metadata says so: `kind: 'design'` and the screens it holds, each
 * `{ id, name, viewport }`. Screen ids are what a spec, a review or a visual
 * check names a screen by, so they are checked when the design is stored.
 * Any other metadata key passes through untouched.
 */

export const DESIGN_SCREEN_ID_RE = /^[A-Za-z0-9._/:#-]{1,128}$/;
export const DESIGN_VIEWPORT_RE = /^[1-9][0-9]{0,4}x[1-9][0-9]{0,4}$/;
export const MAX_DESIGN_SCREENS = 200;

/** Null when fine (or not a design); else a message naming the bad field. */
export function validateDesignMetadata(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null;
  const m = metadata as Record<string, unknown>;
  if (m.kind !== 'design') return null;
  const screens = m.screens;
  if (!Array.isArray(screens) || screens.length === 0) {
    return 'metadata.screens is required for a design: a list of { id, name, viewport }';
  }
  if (screens.length > MAX_DESIGN_SCREENS) return `metadata.screens holds at most ${MAX_DESIGN_SCREENS} screens`;
  const seen = new Set<string>();
  for (let i = 0; i < screens.length; i++) {
    const at = `metadata.screens[${i}]`;
    const s = screens[i];
    if (!s || typeof s !== 'object' || Array.isArray(s)) return `${at} must be an object { id, name, viewport }`;
    const { id, name, viewport } = s as Record<string, unknown>;
    if (typeof id !== 'string' || !DESIGN_SCREEN_ID_RE.test(id)) {
      return `${at}.id must be 1-128 characters of letters, digits and . _ / : # -`;
    }
    if (seen.has(id)) return `${at}.id "${id}" is already used by another screen`;
    seen.add(id);
    if (typeof name !== 'string' || !name.trim()) return `${at}.name is required`;
    if (typeof viewport !== 'string' || !DESIGN_VIEWPORT_RE.test(viewport)) {
      return `${at}.viewport must be WIDTHxHEIGHT in pixels, e.g. 1440x900`;
    }
  }
  return null;
}
