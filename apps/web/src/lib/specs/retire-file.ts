import { markSpecSuperseded } from '@buildd/spec-contract/repo-spec';

/**
 * The pure decisions behind a retired spec's repo file (living-specs §22,
 * R-78, R-80); ./retire-repo-file.ts does the GitHub and database side.
 */

/** What retiring does to the file that stands for a spec: remove its generated copy, else mark its imported source file; null when it has neither. */
export function retirementFileChange(input: { importedPath: string | null | undefined; copyPath: string | null | undefined }): { kind: 'frontmatter' | 'remove'; path: string } | null {
  if (input.copyPath) return { kind: 'remove', path: input.copyPath };
  if (input.importedPath) return { kind: 'frontmatter', path: input.importedPath };
  return null;
}

/** The source file with `status: superseded` and `superseded_by` set, its body as it was; unchanged when it has no frontmatter. */
export function supersededFileText(text: string, supersededBy: string): string {
  return markSpecSuperseded(text, supersededBy) ?? text;
}

/** Restoring never opens a PR (R-80); when a repo file was marked, the page says it still reads superseded. */
export function afterRestore(input: { filePr: number | null | undefined; filePath: string | null | undefined }): { opensPr: false; note: string | null } {
  if (!input.filePath) return { opensPr: false, note: null };
  return { opensPr: false, note: `${input.filePath} still reads superseded: restoring does not edit the repo file.` };
}
