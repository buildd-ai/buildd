import { taskDisplayLabel } from '@buildd/core/task-label';

const CONVENTIONAL_RE =
  /^(feat|fix|chore|docs?|refactor|tests?|ci|perf|build|style|revert|hotfix|release|deps)(?:\(([^)]*)\))?!?:\s*/i;
const BRACKET_RE = /^\s*\[([^\]]*)\]\s*/;

/**
 * The task page header: the conventional-commit type and scope (scope as
 * `taskDisplayLabel` reads it, so chips and the page agree) plus the role move
 * into the eyebrow, and the heading is the subject as a sentence. A retry's
 * bracket prefix ("[builder · after CI #1]") keeps only its qualifier.
 */
export function taskHeading(task: { title: string; label?: string | null }, roleName: string | null): { eyebrow: string[]; heading: string } {
  let rest = task.title.trim();
  let qualifier: string | null = null;
  const bracket = BRACKET_RE.exec(rest);
  if (bracket) {
    rest = rest.slice(bracket[0].length);
    const parts = bracket[1].split('·').map(s => s.trim()).filter(Boolean);
    qualifier = parts.length > 1 ? parts.slice(1).join(' · ') : parts[0] ?? null;
  }
  const conv = CONVENTIONAL_RE.exec(rest);
  const type = conv ? conv[1].toLowerCase() : null;
  const scope = conv ? (taskDisplayLabel({ title: rest, label: task.label ?? null }).scope ?? (conv[2]?.trim() || null)) : null;
  const subject = conv ? rest.slice(conv[0].length).trim() : rest;
  const heading = subject ? subject.charAt(0).toUpperCase() + subject.slice(1) : task.title;
  return {
    eyebrow: [type, scope, roleName, qualifier].filter((x): x is string => !!x),
    heading,
  };
}
