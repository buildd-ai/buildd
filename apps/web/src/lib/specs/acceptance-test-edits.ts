/**
 * R-80: a building task cannot change an acceptance test. A PR from a building
 * task that edits or deletes one is flagged to the person, and that test's
 * result does not count until the person accepts the change.
 *
 * Pure: which files of a PR touch an acceptance test, what is still pending,
 * which checks lose their test result meanwhile. Storage and GitHub reads live
 * in ./acceptance-test-edits-store.ts.
 */

export interface PrFile { filename: string; status: string; sha?: string | null; previous_filename?: string | null }
export type EditChange = 'edited' | 'deleted';
export interface DetectedEdit { path: string; change: EditChange; blobSha: string }
export interface FlaggedEdit extends DetectedEdit { criteria: string[] }
export interface AcceptedEdit { path: string; blobSha: string; by: string; at: string }
export interface AcceptanceEditsRecord {
  prNumber: number;
  headSha: string;
  edits: FlaggedEdit[];
  accepted: AcceptedEdit[];
}

/** An acceptance test the PR modified, removed, or renamed away. Adding a file is not a change to an existing test. */
export function detectAcceptanceTestEdits(acceptancePaths: readonly string[], files: readonly PrFile[]): DetectedEdit[] {
  const tests = new Set(acceptancePaths);
  const found = new Map<string, DetectedEdit>();
  for (const f of files) {
    const blobSha = f.sha ?? '';
    if (f.status === 'renamed' && f.previous_filename && tests.has(f.previous_filename)) {
      found.set(f.previous_filename, { path: f.previous_filename, change: 'deleted', blobSha });
    } else if (tests.has(f.filename)) {
      if (f.status === 'removed') found.set(f.filename, { path: f.filename, change: 'deleted', blobSha });
      else if (f.status === 'modified' || f.status === 'changed' || f.status === 'renamed') found.set(f.filename, { path: f.filename, change: 'edited', blobSha });
    }
  }
  return [...found.values()];
}

/** The scope ids a test file names (its test names carry the check's id). */
export function criteriaInTestSource(source: string, scope: readonly string[]): string[] {
  return scope.filter((id) => new RegExp(`(?<![A-Za-z0-9-])${id}(?![A-Za-z0-9-])`).test(source));
}

const isAccepted = (r: AcceptanceEditsRecord, e: DetectedEdit) => r.accepted.some((a) => a.path === e.path && a.blobSha === e.blobSha);

/** Edits a person has not accepted, at the blob the PR holds now. */
export const pendingEdits = (r: AcceptanceEditsRecord): FlaggedEdit[] => r.edits.filter((e) => !isAccepted(r, e));

/** Checks whose test result is left out of the verdict fold. */
export function excludedCriteria(records: readonly AcceptanceEditsRecord[]): Set<string> {
  return new Set(records.flatMap((r) => pendingEdits(r).flatMap((e) => e.criteria)));
}

/** The PR's current detection replaces the old one; acceptances carry only for a change that is still the same. */
export function recordDetected(prev: AcceptanceEditsRecord | null, now: { prNumber: number; headSha: string; edits: FlaggedEdit[] }): AcceptanceEditsRecord {
  return { prNumber: now.prNumber, headSha: now.headSha, edits: now.edits, accepted: prev?.prNumber === now.prNumber ? prev.accepted : [] };
}

export function acceptEdits(r: AcceptanceEditsRecord, paths: readonly string[], by: string, at: Date = new Date()): AcceptanceEditsRecord {
  const take = pendingEdits(r).filter((e) => paths.includes(e.path));
  return { ...r, accepted: [...r.accepted, ...take.map((e) => ({ path: e.path, blobSha: e.blobSha, by, at: at.toISOString() }))] };
}

/** The line shown on the PR and the mission page. */
export function flagText(r: AcceptanceEditsRecord): string {
  const lines = pendingEdits(r).map((e) => `- \`${e.path}\` ${e.change}${e.criteria.length ? ` (${e.criteria.join(', ')})` : ''}`);
  return [
    'This PR changes an acceptance test. A building task does not change the tests it is judged by.',
    ...lines,
    'That test\'s result does not count until a person accepts the change.',
  ].join('\n');
}

/**
 * Detect and fold one PR snapshot into the record. `readBase` reads a test's
 * text where the PR branched; when it cannot be read, every in-scope check is
 * held rather than guessed (a result nobody can attribute is not trusted).
 */
export async function flagPrEdits(input: {
  acceptancePaths: readonly string[];
  scope: readonly string[];
  files: readonly PrFile[];
  readBase: (path: string) => Promise<string | null>;
  prev: AcceptanceEditsRecord | null;
  prNumber: number;
  headSha: string;
}): Promise<AcceptanceEditsRecord> {
  const found = detectAcceptanceTestEdits(input.acceptancePaths, input.files);
  const edits: FlaggedEdit[] = [];
  for (const e of found) {
    const source = await input.readBase(e.path).catch(() => null);
    const criteria = source === null ? [...input.scope] : criteriaInTestSource(source, input.scope);
    edits.push({ ...e, criteria: criteria.length ? criteria : [...input.scope] });
  }
  return recordDetected(input.prev, { prNumber: input.prNumber, headSha: input.headSha, edits });
}

/** True when the PR gained a pending edit it did not show before: the moment to tell the person. */
export const hasNewPending = (prev: AcceptanceEditsRecord | null, next: AcceptanceEditsRecord): boolean => {
  const seen = new Set(prev ? pendingEdits(prev).map((e) => `${e.path}@${e.blobSha}`) : []);
  return pendingEdits(next).some((e) => !seen.has(`${e.path}@${e.blobSha}`));
};
