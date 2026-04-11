/**
 * Pure helper functions for mission configuration UI.
 */

export interface ModelOption {
  value: string;
  label: string;
}

export const MODEL_OPTIONS: ModelOption[] = [
  { value: '', label: 'Default' },
  { value: 'sonnet', label: 'Claude Sonnet' },
  { value: 'opus', label: 'Claude Opus' },
  { value: 'haiku', label: 'Claude Haiku' },
];

export interface WorkspaceOption {
  id: string;
  name: string;
}

/**
 * Normalize a raw skill input string into a valid slug.
 */
export function normalizeSkillSlug(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Validate whether a skill slug can be added to the existing list.
 */
export function validateSkillSlug(
  input: string,
  existingSlugs: string[]
): string | null {
  const slug = normalizeSkillSlug(input);
  if (!slug) return 'Skill slug cannot be empty';
  if (existingSlugs.includes(slug)) return 'Skill already exists';
  return null;
}

/**
 * Validate a JSON string for use as an output schema.
 */
export function validateOutputSchema(jsonString: string):
  | { valid: true; parsed: unknown; formatted: string }
  | { valid: false; error: string } {
  const trimmed = jsonString.trim();
  if (!trimmed) {
    return { valid: true, parsed: null, formatted: '' };
  }
  try {
    const parsed = JSON.parse(trimmed);
    return { valid: true, parsed, formatted: JSON.stringify(parsed, null, 2) };
  } catch {
    return { valid: false, error: 'Invalid JSON' };
  }
}

/**
 * Build the workspace select options array from a list of workspaces.
 */
export function buildWorkspaceOptions(
  workspaces: WorkspaceOption[]
): { value: string; label: string }[] {
  return [
    { value: '', label: 'No workspace' },
    ...workspaces.map((ws) => ({ value: ws.id, label: ws.name })),
  ];
}
