/**
 * A task whose job is revising a Living Spec (a native buildd spec, written
 * through `manage_specs revise`) is not repo work. The builder role may not
 * change acceptance criteria (verdict-guards.ts), so a builder filing of one is
 * doomed at its first revise. Detection is deliberately narrow: the text must
 * name the `manage_specs` tool (or "Living Spec") together with a revise verb,
 * so a task editing a docs/specs/*.md contract file is left alone.
 */
const MANAGE_SPECS_REVISE = /manage_specs[\s\S]{0,80}\brevis(?:e|ion|ing)\b|\brevis(?:e|ion|ing)\b[\s\S]{0,80}manage_specs/i;
const LIVING_SPEC_REVISE = /\b(?:revis(?:e|ion|ing)|amend(?:ing)?|rewrit(?:e|ing))\b[\s\S]{0,60}\bliving spec\b|\bliving spec\b[\s\S]{0,60}\brevision\b/i;

export function isLivingSpecRevisionTask(input: { title?: string | null; description?: string | null }): boolean {
  const text = `${input.title ?? ''}\n${input.description ?? ''}`;
  return MANAGE_SPECS_REVISE.test(text) || LIVING_SPEC_REVISE.test(text);
}

export const LIVING_SPEC_REVISION_ROLE_REFUSAL =
  'This task revises a Living Spec, and the builder role cannot change acceptance criteria or their test cases ' +
  '(manage_specs revise would be refused with acceptance_role_forbidden). File it with roleSlug "organizer" or "researcher". ' +
  'A Living Spec revision is not a repo file: do not give it a docs/specs pathManifest or pr_required.';
