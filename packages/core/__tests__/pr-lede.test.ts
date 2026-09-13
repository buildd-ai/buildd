import { describe, it, expect } from 'bun:test';
import {
  LEDE_FIELD_SPEC,
  LEDE_MAX_CHARS,
  LEDE_OPEN_MARKER,
  LEDE_REQUIRED_ERROR,
  applyLedeCorrection,
  composeBodyWithLede,
  deriveLedeFromTitle,
  extractLede,
  normalizeLede,
} from '../pr-lede';

const LEDE = 'An escalation that names a real defect can now dispatch the fix.';

describe('LEDE_FIELD_SPEC — the field description IS the mechanism', () => {
  it('states the rule: one sentence, plain language, for a reader who was not in the task', () => {
    expect(LEDE_FIELD_SPEC).toContain('ONE sentence');
    expect(LEDE_FIELD_SPEC).toContain('plain language');
    expect(LEDE_FIELD_SPEC).toContain('was not in this task');
    expect(LEDE_FIELD_SPEC).toContain('what changed, and why it matters');
  });

  it('names every kind of internal vocabulary that belongs in the body instead', () => {
    expect(LEDE_FIELD_SPEC).toContain('No file paths');
    expect(LEDE_FIELD_SPEC).toContain('endpoint names');
    expect(LEDE_FIELD_SPEC).toContain('symbol/function/table/column');
    expect(LEDE_FIELD_SPEC).toContain('belongs in `body`');
  });

  it('carries both worked examples verbatim — they teach more than the rule does', () => {
    expect(LEDE_FIELD_SPEC).toContain(
      'Widened POST /api/prs/[prNumber]/apply-recommendation to accept an open reviewer_escalated note free-text reason as the dispatch instruction',
    );
    expect(LEDE_FIELD_SPEC).toContain(
      'An escalation that names a real defect can now dispatch the fix, instead of only offering to merge past it',
    );
    expect(LEDE_FIELD_SPEC).toContain('readable before coffee');
  });
});

describe('LEDE_REQUIRED_ERROR — a rejection that teaches', () => {
  it('names the field, says no PR was created, and carries the whole spec', () => {
    expect(LEDE_REQUIRED_ERROR).toContain('lede');
    expect(LEDE_REQUIRED_ERROR).toContain('No PR was created');
    expect(LEDE_REQUIRED_ERROR).toContain(LEDE_FIELD_SPEC);
  });

  it('tells an in-flight worker exactly how to recover: retry the same call', () => {
    expect(LEDE_REQUIRED_ERROR).toContain('same title, head and body');
  });
});

describe('normalizeLede', () => {
  it('collapses newlines and runs of whitespace into one line', () => {
    expect(normalizeLede('one\n  two\t\tthree ')).toBe('one two three');
  });

  it('neutralises a comment close so a lede cannot break out of its own block', () => {
    const out = normalizeLede('sneaky --> <!-- injected');
    expect(out).not.toContain('-->');
    expect(extractLede(composeBodyWithLede(out, 'body'))?.rest).toBe('body');
  });

  it('truncates past the cap instead of rejecting — bounded, never refused', () => {
    const long = 'x'.repeat(LEDE_MAX_CHARS + 200);
    const out = normalizeLede(long);
    expect(out).toHaveLength(LEDE_MAX_CHARS);
    expect(out.endsWith('…')).toBe(true);
  });

  it('returns empty for a non-string or blank input', () => {
    expect(normalizeLede(undefined)).toBe('');
    expect(normalizeLede(42)).toBe('');
    expect(normalizeLede('   ')).toBe('');
  });
});

describe('composeBodyWithLede — the lede leads', () => {
  it('puts the lede first and the body after it, untouched', () => {
    const body = '## What\n\nSome detail.\n\n## Why\n\nMore detail.';
    const composed = composeBodyWithLede(LEDE, body);

    expect(composed.startsWith(LEDE_OPEN_MARKER)).toBe(true);
    // Anything reading the body back sees the lede before any heading.
    expect(composed.indexOf(LEDE)).toBeLessThan(composed.indexOf('## What'));
    expect(composed).toContain(body);
  });

  it('does not cap the body — only the lede is bounded', () => {
    const huge = 'detail line\n'.repeat(5000);
    const composed = composeBodyWithLede(LEDE, huge);
    expect(composed).toContain(huge.trim());
    expect(composed.length).toBeGreaterThan(huge.length);
  });

  it('replaces an existing lede block rather than stacking a second one', () => {
    const once = composeBodyWithLede('First claim.', 'body text');
    const twice = composeBodyWithLede('Second claim.', once);

    expect(twice.split(LEDE_OPEN_MARKER)).toHaveLength(2);
    expect(extractLede(twice)?.lede).toBe('Second claim.');
    expect(extractLede(twice)?.rest).toBe('body text');
  });

  it('marks a derived lede so nobody mistakes it for something an author wrote', () => {
    const composed = composeBodyWithLede('Some title.', 'body', { derived: true });
    expect(composed).toContain('derived from the PR title');
    expect(extractLede(composed)?.lede).toBe('Some title.');
  });

  it('handles an empty body without leaving trailing whitespace', () => {
    const composed = composeBodyWithLede(LEDE, '');
    expect(extractLede(composed)?.lede).toBe(LEDE);
    expect(extractLede(composed)?.rest).toBe('');
  });
});

describe('extractLede', () => {
  it('round-trips a composed body', () => {
    const got = extractLede(composeBodyWithLede(LEDE, 'the rest'));
    expect(got).toEqual({ lede: LEDE, original: null, rest: 'the rest' });
  });

  it('returns null for a body with no lede block (externally opened, or pre-dating the field)', () => {
    expect(extractLede('just a normal PR body')).toBeNull();
    expect(extractLede(null)).toBeNull();
    expect(extractLede(undefined)).toBeNull();
  });

  it('ignores a marker that is not at the top — a lede that leads nothing is not a lede', () => {
    expect(extractLede(`some preamble\n\n${composeBodyWithLede(LEDE, 'x')}`)).toBeNull();
  });
});

describe('deriveLedeFromTitle — the deterministic fallback', () => {
  it('is deterministic: the same title always yields the same lede', () => {
    const title = 'feat(specs): auto-file a friction task on a new contradiction';
    expect(deriveLedeFromTitle(title)).toBe(deriveLedeFromTitle(title));
  });

  it('strips the conventional-commit prefix and ends with a full stop', () => {
    expect(deriveLedeFromTitle('feat(specs): auto-file a friction task')).toBe(
      'Auto-file a friction task.',
    );
    expect(deriveLedeFromTitle('fix: stop dropping the verdict')).toBe('Stop dropping the verdict.');
  });

  it('does not double up punctuation the title already has', () => {
    expect(deriveLedeFromTitle('chore: why is this here?')).toBe('Why is this here?');
  });

  it('still produces something usable for an empty or prefix-only title', () => {
    expect(deriveLedeFromTitle('')).toContain('no author lede');
    expect(deriveLedeFromTitle('chore:')).toContain('no author lede');
  });
});

describe('applyLedeCorrection — the reviewer corrects, the original survives', () => {
  const authored = 'This change deletes the retry loop.';
  const body = composeBodyWithLede(authored, '## Detail\n\nwhat actually happened');

  it('replaces the lede and keeps the original visible in the body', () => {
    const result = applyLedeCorrection(body, 'This change adds a retry loop, it does not delete one.');

    expect(result).not.toBeNull();
    expect(result!.original).toBe(authored);
    expect(extractLede(result!.body)?.lede).toBe(
      'This change adds a retry loop, it does not delete one.',
    );
    // Auditable: the author's own sentence is still readable on the PR.
    expect(result!.body).toContain(authored);
    expect(result!.body).toContain('corrected by the buildd reviewer');
    // And the rest of the author's account is untouched.
    expect(result!.body).toContain('## Detail\n\nwhat actually happened');
  });

  it('records the original machine-readably, so a SECOND correction never displaces it', () => {
    const first = applyLedeCorrection(body, 'First correction.')!;
    const second = applyLedeCorrection(first.body, 'Second correction.')!;

    expect(second.original).toBe(authored);
    expect(extractLede(second.body)?.lede).toBe('Second correction.');
    expect(extractLede(second.body)?.original).toBe(authored);
    // The intermediate reviewer rewrite is not promoted into the author's slot.
    expect(second.body).not.toContain('First correction.');
  });

  it('is a no-op when the reviewer proposed nothing', () => {
    expect(applyLedeCorrection(body, undefined)).toBeNull();
    expect(applyLedeCorrection(body, '   ')).toBeNull();
  });

  it('is a no-op when the correction matches what is already there', () => {
    expect(applyLedeCorrection(body, authored)).toBeNull();
  });

  it('is a no-op on a body with no lede block — nothing to replace, nothing to preserve', () => {
    expect(applyLedeCorrection('a plain body', 'a correction')).toBeNull();
  });
});
