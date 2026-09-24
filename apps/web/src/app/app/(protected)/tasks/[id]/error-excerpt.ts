/**
 * The failed phase's one-line error for the action zone. The full text is
 * already on the page under agent error traces, so the zone shows the first
 * line, capped. Pure.
 */
export const ERROR_EXCERPT_MAX = 200;

export function truncateExcerpt(error: string | null | undefined): string | null {
  const text = error?.trim();
  if (!text) return null;
  const newline = text.indexOf('\n');
  const firstLine = newline === -1 ? text : text.slice(0, newline).trimEnd();
  if (firstLine.length > ERROR_EXCERPT_MAX) return `${firstLine.slice(0, ERROR_EXCERPT_MAX)}…`;
  return newline === -1 ? firstLine : `${firstLine}…`;
}
