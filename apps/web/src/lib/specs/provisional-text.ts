import { LEDE_CLOSE_MARKER } from '@buildd/core/pr-lede';
import { requirementIds } from '@buildd/spec-contract/requirements';

/**
 * The words a PR carries about work built ahead of approval (living-specs.md
 * §20, R-38 and R-41), and the criterion text a carried verdict is compared on
 * (R-40). Pure: the create-PR route and the re-grade both call it.
 *
 * The block sits between markers, under the lede, so a later re-grade replaces
 * it in place instead of adding a second one.
 */

export const SPEC_SOURCE_OPEN = '<!-- buildd-spec-source -->';
export const SPEC_SOURCE_CLOSE = '<!-- /buildd-spec-source -->';

type Pin = Record<string, unknown> | null | undefined;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) ? v : null);

/** The one line for this pin, or null when there is nothing to say (an ordinary pin, or none). */
export function specSourceLine(pin: Pin): string | null {
  if (!pin || typeof pin.specId !== 'string') return null;
  const revision = num(pin.revision);
  if (revision === null) return null;
  const from = num((pin.regradedFrom as Record<string, unknown> | undefined)?.revision);
  if (from !== null) {
    return `**Spec:** Built ahead of approval against revision ${from}, re-graded against approved revision ${revision}.`;
  }
  if (pin.provisional === true) {
    return `**Spec:** Built ahead of approval, against revision ${revision}. When a person approves the spec, this work is re-graded against the approved revision.`;
  }
  return null;
}

/** `body` with this pin's block: replaced in place when present, else under the lede, else first. */
export function withSpecSourceBlock(body: string, pin: Pin): string {
  const line = specSourceLine(pin);
  if (!line) return body;
  const block = `${SPEC_SOURCE_OPEN}\n${line}\n${SPEC_SOURCE_CLOSE}`;
  const start = body.indexOf(SPEC_SOURCE_OPEN);
  const end = start >= 0 ? body.indexOf(SPEC_SOURCE_CLOSE, start) : -1;
  if (start >= 0 && end >= 0) return body.slice(0, start) + block + body.slice(end + SPEC_SOURCE_CLOSE.length);
  const lede = body.indexOf(LEDE_CLOSE_MARKER);
  if (lede >= 0) {
    const at = lede + LEDE_CLOSE_MARKER.length;
    return `${body.slice(0, at)}\n\n${block}\n\n${body.slice(at).replace(/^\n+/, '')}`;
  }
  return body ? `${block}\n\n${body}` : block;
}

/**
 * Each criterion's text: its defining line and the lines under it, up to the
 * next defined id or heading, each trimmed, blank lines dropped. A changed
 * check line under a criterion changes its text; re-indenting does not.
 */
export function criterionTexts(body: string): Map<string, string> {
  const lines = body.split('\n');
  const defs = requirementIds(body);
  const starts = new Set(defs.map((d) => d.line - 1));
  const out = new Map<string, string>();
  for (const d of defs) {
    if (d.kind !== 'requirement' && d.kind !== 'acceptance') continue;
    const block: string[] = [];
    for (let i = d.line - 1; i < lines.length; i++) {
      if (i > d.line - 1 && (starts.has(i) || /^\s*#/.test(lines[i]!))) break;
      const t = lines[i]!.trim();
      if (t) block.push(t);
    }
    out.set(d.id, block.join('\n'));
  }
  return out;
}
