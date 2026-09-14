/**
 * The PR lede — one plain-language sentence at the top of every PR body.
 *
 * WHY THIS EXISTS
 * PR bodies were unstandardised in shape and unbounded in length, and the first
 * sentence was typically implementation vocabulary: accurate, and useless to
 * someone reading the PR list on a phone. The lede is the fix — the point,
 * before the scroll.
 *
 * WHAT THIS IS NOT
 * This module contains NO style checker. Nothing here inspects, scores, or
 * rejects a lede for how it is written. `lede` is a REQUIRED field on
 * `create_pr`, so the only way it can fail is by being ABSENT — a contract
 * error the agent sees before any PR exists, never a judgement on its prose.
 * Failing already-correct work over writing quality would force an expensive
 * retry to fix a cheap problem, which is the exact failure shape this design
 * was told to avoid.
 *
 * STORED IN THE BODY, NOT BESIDE IT
 * The lede is COMPOSED INTO the PR body at creation time, wrapped in HTML
 * comment markers, rather than kept in a column of its own. GitHub's PR body is
 * the durable artifact: it is what the `pr` knowledge corpus ingests, what
 * `get_pr` returns, what a human opens. A separate column would need every one
 * of those readers to join against it and put the lede first themselves — three
 * places to forget, and a body that reads wrong anywhere they do. Composing it
 * in means "the lede leads" is true by construction for every reader, including
 * ones that predate this feature and ones nobody has written yet.
 *
 * The markers are what make the block machine-addressable afterwards, so the
 * reviewer's correction (see `applyLedeCorrection`) can replace exactly the
 * lede and nothing else, while keeping the author's original visible.
 *
 * Total body length is deliberately NOT capped anywhere in this module. The
 * full body is the durable record searched later; truncating it degrades
 * retrieval. Only the lede is bounded.
 */

/** Opening marker of the lede block. */
export const LEDE_OPEN_MARKER = '<!-- buildd-lede -->';
/** Closing marker of the lede block. */
export const LEDE_CLOSE_MARKER = '<!-- /buildd-lede -->';
/** Carries the author's original lede once a reviewer has corrected it. */
const LEDE_ORIGINAL_PREFIX = '<!-- buildd-lede-original:';
const COMMENT_CLOSE = '-->';

/**
 * Hard cap on the lede, in characters. A lede over this is TRUNCATED, never
 * rejected — the mechanism stays "can only fail by being absent". Roughly two
 * lines on a phone, which is the whole point of the field.
 */
export const LEDE_MAX_CHARS = 240;

/**
 * The field description, verbatim, for `create_pr`'s `lede` param and for the
 * error an agent gets when it omits it.
 *
 * This text IS the mechanism. There is no validator behind it; what an agent
 * writes is shaped entirely by what this says and by the two examples, which
 * carry more than the rule does.
 */
export const LEDE_FIELD_SPEC = [
  'ONE sentence, plain language, written for a reader who was not in this task:',
  'what changed, and why it matters to them. Say it the way you would say it out',
  'loud to a colleague.',
  '',
  'No file paths, no route or endpoint names, no symbol/function/table/column',
  'names, no internal vocabulary — all of that belongs in `body`, below the lede,',
  'under headings. The lede leads the PR body, so it is the first (often the only)',
  `thing a human reads on a phone. Max ${LEDE_MAX_CHARS} characters; a longer one is`,
  'truncated, never rejected.',
  '',
  "BAD:  'Widened POST /api/prs/[prNumber]/apply-recommendation to accept an open reviewer_escalated note free-text reason as the dispatch instruction'",
  "GOOD: 'An escalation that names a real defect can now dispatch the fix, instead of only offering to merge past it'",
  '',
  'Same change. One is readable before coffee.',
].join('\n');

/**
 * What an agent gets back when it calls `create_pr` without a lede.
 *
 * Deliberately self-correcting rather than merely correct. A worker already in
 * flight when this shipped read the OLD tool description and cannot know about
 * the field, so the rejection has to teach it the whole contract in one shot and
 * say plainly that nothing was lost — one retry of the same call, no rework.
 */
export const LEDE_REQUIRED_ERROR = [
  'create_pr requires a `lede` and none was supplied. No PR was created — nothing else about your call was wrong.',
  '',
  LEDE_FIELD_SPEC,
  '',
  'Call create_pr again with the same title, head and body, plus `lede`.',
].join('\n');

/**
 * Reduce arbitrary agent text to a single bounded line that can live inside an
 * HTML comment block without breaking it.
 *
 * Mechanical only: whitespace collapse, marker-safety, length cap. It never
 * looks at what the sentence says.
 */
export function normalizeLede(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const flattened = raw
    .replace(/\s+/g, ' ')
    // A literal comment close inside the lede would terminate our marker block
    // early and orphan the rest of the body outside it.
    .replaceAll(COMMENT_CLOSE, '--&gt;')
    .trim();
  if (flattened.length <= LEDE_MAX_CHARS) return flattened;
  return `${flattened.slice(0, LEDE_MAX_CHARS - 1).trimEnd()}…`;
}

/** Strip a conventional-commit prefix (`feat(scope):`, `fix:`) from a title. */
function stripConventionalPrefix(title: string): string {
  return title.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, '');
}

/**
 * The deterministic fallback lede, derived from the PR title alone.
 *
 * Used where a lede cannot be required: a PR created OUTSIDE buildd and
 * registered after the fact (`create_pr` with `prUrl`). That PR already exists
 * on GitHub — refusing to register it would strand a real pull request over a
 * missing sentence, which is precisely the failure this feature must not cause.
 * So the title becomes the lede, marked as derived so nobody mistakes it for
 * something the author wrote.
 *
 * Deterministic by construction: pure string work, no model call, same title
 * always yields the same lede.
 */
export function deriveLedeFromTitle(title: string): string {
  const stripped = stripConventionalPrefix(typeof title === 'string' ? title : '').trim();
  if (!stripped) return 'This pull request was registered from outside buildd and carries no author lede.';
  const sentence = /[.!?]$/.test(stripped) ? stripped : `${stripped}.`;
  return normalizeLede(sentence.charAt(0).toUpperCase() + sentence.slice(1));
}

/** Note appended under a derived lede so its provenance is never ambiguous. */
export const DERIVED_LEDE_NOTE =
  '<sub>Lede derived from the PR title — this pull request was opened outside buildd, so its author supplied none.</sub>';

export interface ExtractedLede {
  /** The lede currently leading the body. */
  lede: string;
  /** The author's original, when a reviewer has since corrected it. */
  original: string | null;
  /** Everything after the lede block, with the leading blank line removed. */
  rest: string;
}

/**
 * Read the lede block back out of a PR body. Returns null for a body that has
 * none — an externally-opened PR, or one created before this feature shipped.
 */
export function extractLede(body: string | null | undefined): ExtractedLede | null {
  if (typeof body !== 'string') return null;
  const start = body.indexOf(LEDE_OPEN_MARKER);
  if (start !== 0 && start !== -1) {
    // A lede block that isn't at the top isn't leading anything; treat the body
    // as unledeed rather than silently editing something mid-document.
    return null;
  }
  if (start === -1) return null;
  const end = body.indexOf(LEDE_CLOSE_MARKER, start);
  if (end === -1) return null;

  const inner = body.slice(start + LEDE_OPEN_MARKER.length, end);
  const rest = body.slice(end + LEDE_CLOSE_MARKER.length).replace(/^\n+/, '');

  let original: string | null = null;
  const origStart = inner.indexOf(LEDE_ORIGINAL_PREFIX);
  let ledeText = inner;
  if (origStart !== -1) {
    const origEnd = inner.indexOf(COMMENT_CLOSE, origStart);
    if (origEnd !== -1) {
      try {
        const parsed = JSON.parse(inner.slice(origStart + LEDE_ORIGINAL_PREFIX.length, origEnd).trim());
        if (typeof parsed === 'string') original = parsed;
      } catch {
        // Corrupt marker: the correction notice below is still human-readable,
        // so degrade to "no machine-readable original" rather than bailing.
      }
      ledeText = inner.slice(0, origStart) + inner.slice(origEnd + COMMENT_CLOSE.length);
    }
  }

  // The first non-empty, non-`<sub>` line is the lede itself; the `<sub>` lines
  // are provenance notes this module wrote.
  const lede =
    ledeText
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith('<sub>')) ?? '';

  return { lede, original, rest };
}

/**
 * Put `lede` at the top of `body`, replacing an existing lede block if there is
 * one. The rest of the body is passed through untouched and uncapped.
 *
 * `derived` marks a lede this module produced from the title rather than one an
 * author wrote (see `deriveLedeFromTitle`).
 */
export function composeBodyWithLede(
  lede: string,
  body: string | null | undefined,
  opts: { derived?: boolean } = {},
): string {
  const clean = normalizeLede(lede);
  const existing = extractLede(body);
  const rest = existing ? existing.rest : (typeof body === 'string' ? body : '');

  const block = [
    LEDE_OPEN_MARKER,
    clean,
    ...(opts.derived ? ['', DERIVED_LEDE_NOTE] : []),
    LEDE_CLOSE_MARKER,
  ].join('\n');

  return rest.trim().length > 0 ? `${block}\n\n${rest}` : block;
}

export interface LedeCorrectionResult {
  /** The rewritten body, lede replaced and original preserved. */
  body: string;
  /** The lede this correction displaced — the author's own, first time round. */
  original: string;
  /** The reviewer's replacement, after normalization. */
  corrected: string;
}

/**
 * Replace the lede in `body` with the reviewer's corrected one, KEEPING THE
 * AUTHOR'S ORIGINAL VISIBLE.
 *
 * The body is the author's account of its own work and it becomes the durable
 * record. A silent overwrite would let the reviewer's rewrite be retrieved later
 * as though the author had written it, so the original stays in the block twice
 * over: once as prose a human reads, once as a machine-readable marker so a
 * SECOND correction still displaces only the current text and never the
 * author's.
 *
 * Returns null when there is nothing to correct — no lede block (an externally
 * opened PR, or one predating this feature), an empty correction, or a
 * correction identical to what is already there. A null is a no-op, not a
 * failure: the caller leaves the body alone.
 */
export function applyLedeCorrection(
  body: string | null | undefined,
  correctedLede: unknown,
): LedeCorrectionResult | null {
  const corrected = normalizeLede(correctedLede);
  if (!corrected) return null;

  const existing = extractLede(body);
  if (!existing) return null;
  if (existing.lede === corrected) return null;

  // First correction: the displaced lede IS the author's. Later corrections
  // must not promote a previous reviewer rewrite into that slot.
  const original = existing.original ?? existing.lede;

  const block = [
    LEDE_OPEN_MARKER,
    `${LEDE_ORIGINAL_PREFIX}${JSON.stringify(original)} ${COMMENT_CLOSE}`,
    corrected,
    '',
    `<sub>Lede corrected by the buildd reviewer — the original contradicted the diff. Original, as the author wrote it: “${original}”</sub>`,
    LEDE_CLOSE_MARKER,
  ].join('\n');

  const nextBody = existing.rest.trim().length > 0 ? `${block}\n\n${existing.rest}` : block;
  return { body: nextBody, original, corrected };
}
