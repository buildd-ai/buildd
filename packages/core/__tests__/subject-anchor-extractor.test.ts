/**
 * Unit tests for extractSubjectAnchor() — pure function with no DB or network calls.
 *
 * Covers every normalization rule from docs/design/task-subject-anchors.md §1 and §2:
 *   - headSha: lowercase hex, 7–64 chars
 *   - branch: strip refs/heads/ prefix, otherwise case-sensitive
 *   - errorSignature: known slug catalog or namespaced system sig; free-form rejected
 *   - failingCheckNames: trim, case-preserve, dedup, sort, bound 50×200
 *   - URL parsing from title/description
 *   - Text pattern parsing (PR #N, pull request #N)
 *   - Legacy context key mapping
 *   - System context (highest precedence)
 *   - Explicit subjectAnchor API field (second precedence)
 *   - Ambiguous multiple PRs → no anchor + warning
 *   - Title/embedding similarity → never an anchor (negative table test)
 *   - PR anchor requires prNumber
 */
import { describe, it, expect } from 'bun:test';
import {
  extractSubjectAnchor,
  normalizeHeadSha,
  normalizeBranch,
  normalizeErrorSignature,
  normalizeFailingCheckNames,
  KNOWN_ERROR_SLUGS,
  type AnchorExtractionInput,
} from '../subject-anchor-extractor';

// ── normalizeHeadSha ─────────────────────────────────────────────────────────

describe('normalizeHeadSha', () => {
  it('accepts a full 40-char SHA and lowercases it', () => {
    const sha = 'A'.repeat(40);
    expect(normalizeHeadSha(sha)).toBe('a'.repeat(40));
  });

  it('accepts a 7-char short SHA', () => {
    expect(normalizeHeadSha('abc1234')).toBe('abc1234');
  });

  it('accepts a 64-char SHA (max)', () => {
    expect(normalizeHeadSha('f'.repeat(64))).toBe('f'.repeat(64));
  });

  it('rejects a 6-char string (too short)', () => {
    expect(normalizeHeadSha('abc123')).toBeNull();
  });

  it('rejects a 65-char string (too long)', () => {
    expect(normalizeHeadSha('a'.repeat(65))).toBeNull();
  });

  it('rejects non-hex characters', () => {
    expect(normalizeHeadSha('zzzzzzzzzzzzzzzz')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(normalizeHeadSha('')).toBeNull();
  });

  it('accepts mixed-case hex and normalizes to lowercase', () => {
    expect(normalizeHeadSha('AbCdEf1234567')).toBe('abcdef1234567');
  });
});

// ── normalizeBranch ──────────────────────────────────────────────────────────

describe('normalizeBranch', () => {
  it('strips refs/heads/ prefix', () => {
    expect(normalizeBranch('refs/heads/my-feature')).toBe('my-feature');
  });

  it('leaves a plain branch name unchanged', () => {
    expect(normalizeBranch('dev')).toBe('dev');
  });

  it('is case-sensitive — preserves mixed case', () => {
    expect(normalizeBranch('MyFeature/Fix-Auth')).toBe('MyFeature/Fix-Auth');
  });

  it('does not strip refs/tags/ (not a heads ref)', () => {
    expect(normalizeBranch('refs/tags/v1.2.3')).toBe('refs/tags/v1.2.3');
  });

  it('handles nested slashes after refs/heads/ removal', () => {
    expect(normalizeBranch('refs/heads/team/alpha/fix')).toBe('team/alpha/fix');
  });

  it('rejects empty string', () => {
    expect(normalizeBranch('')).toBeNull();
  });

  it('rejects whitespace-only string', () => {
    expect(normalizeBranch('   ')).toBeNull();
  });
});

// ── normalizeErrorSignature ──────────────────────────────────────────────────

describe('normalizeErrorSignature', () => {
  it('accepts every known scanner slug', () => {
    for (const slug of KNOWN_ERROR_SLUGS) {
      expect(normalizeErrorSignature(slug)).toBe(slug);
    }
  });

  it('accepts a namespaced system signature (namespace:slug)', () => {
    expect(normalizeErrorSignature('watcher:pr_conflict')).toBe('watcher:pr_conflict');
    expect(normalizeErrorSignature('ci:check_timeout')).toBe('ci:check_timeout');
  });

  it('rejects free-form error text', () => {
    expect(normalizeErrorSignature('Cannot read properties of undefined')).toBeNull();
  });

  it('rejects empty string', () => {
    expect(normalizeErrorSignature('')).toBeNull();
  });

  it('rejects an unknown bare slug not in the catalog', () => {
    expect(normalizeErrorSignature('some_unknown_error')).toBeNull();
  });

  it('rejects a slug with spaces', () => {
    expect(normalizeErrorSignature('cd no such file')).toBeNull();
  });

  it('rejects a namespaced sig with empty namespace', () => {
    expect(normalizeErrorSignature(':slug')).toBeNull();
  });

  it('rejects a namespaced sig with empty slug part', () => {
    expect(normalizeErrorSignature('ns:')).toBeNull();
  });
});

// ── normalizeFailingCheckNames ───────────────────────────────────────────────

describe('normalizeFailingCheckNames', () => {
  it('trims whitespace from each name', () => {
    expect(normalizeFailingCheckNames(['  ci / build  ', 'test'])).toEqual(['ci / build', 'test']);
  });

  it('preserves original case', () => {
    expect(normalizeFailingCheckNames(['TypeScript', 'eslint'])).toEqual(['TypeScript', 'eslint']);
  });

  it('deduplicates entries', () => {
    expect(normalizeFailingCheckNames(['ci', 'ci', 'test'])).toEqual(['ci', 'test']);
  });

  it('sorts entries alphabetically', () => {
    expect(normalizeFailingCheckNames(['z-check', 'a-check', 'm-check'])).toEqual([
      'a-check',
      'm-check',
      'z-check',
    ]);
  });

  it('drops entries longer than 200 chars', () => {
    const tooLong = 'x'.repeat(201);
    const ok = 'short';
    expect(normalizeFailingCheckNames([tooLong, ok])).toEqual([ok]);
  });

  it('bounds output to 50 entries', () => {
    const names = Array.from({ length: 60 }, (_, i) => `check-${String(i).padStart(3, '0')}`);
    const result = normalizeFailingCheckNames(names);
    expect(result.length).toBe(50);
  });

  it('returns empty array for empty input', () => {
    expect(normalizeFailingCheckNames([])).toEqual([]);
  });

  it('drops empty-after-trim entries', () => {
    expect(normalizeFailingCheckNames(['  ', '', 'real-check'])).toEqual(['real-check']);
  });
});

// ── Helpers ──────────────────────────────────────────────────────────────────

const WS_REPO = 'buildd-ai/buildd';

function extract(input: AnchorExtractionInput) {
  return extractSubjectAnchor(input);
}

// ── extractSubjectAnchor — null cases ────────────────────────────────────────

describe('extractSubjectAnchor — returns null when no subject found', () => {
  it('returns null for empty input', () => {
    const result = extract({});
    expect(result.anchor).toBeNull();
    expect(result.warnings).toEqual([]);
  });

  it('returns null for generic title with no PR/error/branch signal', () => {
    const result = extract({ title: 'Fix the login button', description: 'It is broken' });
    expect(result.anchor).toBeNull();
  });

  it('never produces an anchor from title/description similarity alone', () => {
    // Table test: these titles look PR-adjacent but have no structured identity
    const titles = [
      'Looks like PR 123',
      'Related to pull request work',
      'Similar to the CI failures',
      'Investigate #123',            // bare hash, no explicit "PR" prefix
      'Branch work on dev',
      'Fix error in code',
    ];
    for (const title of titles) {
      const result = extract({ title, workspaceRepo: WS_REPO });
      expect(result.anchor).toBeNull();
    }
  });
});

// ── URL parsing ───────────────────────────────────────────────────────────────

describe('extractSubjectAnchor — GitHub PR URL parsing', () => {
  it('extracts prNumber from an exact GitHub PR URL in the title', () => {
    const result = extract({
      title: 'Fix https://github.com/buildd-ai/buildd/pull/42',
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor).not.toBeNull();
    expect(result.anchor!.kind).toBe('pull_request');
    expect(result.anchor!.prNumber).toBe(42);
    expect(result.anchor!.source).toBe('url');
    expect(result.anchor!.confidence).toBe('derived');
  });

  it('extracts prNumber from an exact GitHub PR URL in the description', () => {
    const result = extract({
      title: 'Fix auth',
      description: 'See https://github.com/buildd-ai/buildd/pull/99 for context.',
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.prNumber).toBe(99);
    expect(result.anchor?.source).toBe('url');
  });

  it('strips query strings and fragments from PR URLs', () => {
    const result = extract({
      title: 'https://github.com/buildd-ai/buildd/pull/7?files=1#diff-abc',
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.prNumber).toBe(7);
  });

  it('ignores a GitHub PR URL from a different repository', () => {
    const result = extract({
      title: 'Review https://github.com/other-org/other-repo/pull/10',
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor).toBeNull();
  });

  it('returns no anchor and a warning when multiple different PR URLs are present', () => {
    const result = extract({
      title: 'Fix https://github.com/buildd-ai/buildd/pull/1 and https://github.com/buildd-ai/buildd/pull/2',
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor).toBeNull();
    expect(result.warnings.some((w) => w.includes('ambiguous'))).toBe(true);
  });

  it('deduplicates the same PR URL mentioned twice — no ambiguity', () => {
    const url = 'https://github.com/buildd-ai/buildd/pull/5';
    const result = extract({
      title: `See ${url} and ${url}`,
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.prNumber).toBe(5);
    expect(result.warnings).toEqual([]);
  });

  it('ignores a PR URL when workspaceRepo is not provided', () => {
    const result = extract({
      title: 'https://github.com/buildd-ai/buildd/pull/42',
    });
    expect(result.anchor).toBeNull();
  });

  it('rejects a zero PR number in the URL', () => {
    const result = extract({
      title: 'https://github.com/buildd-ai/buildd/pull/0',
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor).toBeNull();
  });
});

// ── Text pattern parsing (PR #N) ─────────────────────────────────────────────

describe('extractSubjectAnchor — text pattern parsing', () => {
  it('extracts prNumber from "PR #N" when workspaceRepo is set', () => {
    const result = extract({ title: 'Retry for PR #123', workspaceRepo: WS_REPO });
    expect(result.anchor?.prNumber).toBe(123);
    expect(result.anchor?.source).toBe('text');
    expect(result.anchor?.confidence).toBe('derived');
  });

  it('extracts prNumber from "pull request #N" (case-insensitive)', () => {
    const result = extract({ title: 'Fix the Pull Request #456', workspaceRepo: WS_REPO });
    expect(result.anchor?.prNumber).toBe(456);
    expect(result.anchor?.source).toBe('text');
  });

  it('does NOT extract from bare "#N" without PR prefix', () => {
    const result = extract({ title: 'See issue #99', workspaceRepo: WS_REPO });
    expect(result.anchor).toBeNull();
  });

  it('does NOT extract when workspaceRepo is absent (single-repo requirement)', () => {
    const result = extract({ title: 'Retry for PR #123' });
    expect(result.anchor).toBeNull();
  });

  it('returns no anchor and ambiguity warning for two different PR #N in text', () => {
    const result = extract({
      title: 'Fix PR #10 and PR #11',
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor).toBeNull();
    expect(result.warnings.some((w) => w.includes('ambiguous'))).toBe(true);
  });
});

// ── Legacy context mapping ───────────────────────────────────────────────────

describe('extractSubjectAnchor — legacy context key mapping', () => {
  it('maps context.prNumber to prNumber', () => {
    const result = extract({ context: { prNumber: 77 }, workspaceRepo: WS_REPO });
    expect(result.anchor?.prNumber).toBe(77);
    expect(result.anchor?.source).toBe('context');
    expect(result.anchor?.confidence).toBe('exact');
  });

  it('maps context.pr (alias) to prNumber', () => {
    const result = extract({ context: { pr: 88 }, workspaceRepo: WS_REPO });
    expect(result.anchor?.prNumber).toBe(88);
  });

  it('maps context.headSha', () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const result = extract({ context: { prNumber: 1, headSha: sha }, workspaceRepo: WS_REPO });
    expect(result.anchor?.headSha).toBe(sha);
  });

  it('normalizes context.headSha to lowercase', () => {
    const sha = 'ABCDEF1234567890ABCDEF1234567890ABCDEF12';
    const result = extract({ context: { prNumber: 1, headSha: sha }, workspaceRepo: WS_REPO });
    expect(result.anchor?.headSha).toBe(sha.toLowerCase());
  });

  it('ignores context.headSha if not valid hex 7–64 chars', () => {
    const result = extract({ context: { prNumber: 1, headSha: 'not-a-sha' }, workspaceRepo: WS_REPO });
    expect(result.anchor?.headSha).toBeUndefined();
  });

  it('maps context.frictionSignature to errorSignature', () => {
    const result = extract({ context: { frictionSignature: 'bwrap_namespace_denied' } });
    expect(result.anchor?.kind).toBe('error');
    expect(result.anchor?.errorSignature).toBe('bwrap_namespace_denied');
    expect(result.anchor?.source).toBe('context');
  });

  it('rejects context.frictionSignature that is free-form text', () => {
    const result = extract({ context: { frictionSignature: 'some random error text' } });
    expect(result.anchor).toBeNull();
  });

  it('maps context.baseBranch as branch', () => {
    const result = extract({ context: { baseBranch: 'refs/heads/dev' } });
    expect(result.anchor?.kind).toBe('branch');
    expect(result.anchor?.branch).toBe('dev');
  });

  it('maps context.resumeBranch as branch', () => {
    const result = extract({ context: { resumeBranch: 'my-fix-branch' } });
    expect(result.anchor?.kind).toBe('branch');
    expect(result.anchor?.branch).toBe('my-fix-branch');
  });

  it('maps CI retry fields — ciRetryPrNumber + ciRetryHeadSha', () => {
    const sha = 'deadbeef'.repeat(5); // 40 chars
    const result = extract({
      context: { ciRetryPrNumber: 200, ciRetryHeadSha: sha },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.prNumber).toBe(200);
    expect(result.anchor?.headSha).toBe(sha);
    expect(result.anchor?.source).toBe('context');
    expect(result.anchor?.confidence).toBe('exact');
  });
});

// ── System context (highest precedence) ─────────────────────────────────────

describe('extractSubjectAnchor — system context (highest precedence)', () => {
  it('uses systemContext prNumber over URL-parsed prNumber', () => {
    const result = extract({
      title: 'https://github.com/buildd-ai/buildd/pull/5',
      workspaceRepo: WS_REPO,
      systemContext: { prNumber: 99, origin: 'webhook' },
    });
    expect(result.anchor?.prNumber).toBe(99);
    expect(result.anchor?.source).toBe('system');
    expect(result.anchor?.confidence).toBe('exact');
  });

  it('uses systemContext over legacy context keys', () => {
    const result = extract({
      context: { prNumber: 10 },
      systemContext: { prNumber: 20, origin: 'watcher' },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.prNumber).toBe(20);
    expect(result.anchor?.source).toBe('system');
  });

  it('normalizes headSha from systemContext', () => {
    const sha = 'DEADBEEF'.repeat(5);
    const result = extract({
      systemContext: { prNumber: 1, headSha: sha, origin: 'webhook' },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.headSha).toBe(sha.toLowerCase());
  });

  it('includes failingCheckNames from systemContext — trimmed, deduped, sorted', () => {
    const result = extract({
      systemContext: {
        prNumber: 1,
        failingCheckNames: ['z-check', ' a-check ', 'z-check'],
        origin: 'webhook',
      },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.failingCheckNames).toEqual(['a-check', 'z-check']);
  });

  it('maps systemContext.errorSignature for error anchors', () => {
    const result = extract({
      systemContext: { errorSignature: 'bwrap_namespace_denied', origin: 'watcher' },
    });
    expect(result.anchor?.kind).toBe('error');
    expect(result.anchor?.errorSignature).toBe('bwrap_namespace_denied');
  });

  it('rejects systemContext.errorSignature that is not a known slug', () => {
    const result = extract({
      systemContext: { errorSignature: 'unknown free form text', origin: 'watcher' },
    });
    expect(result.anchor).toBeNull();
  });

  it('strips refs/heads/ from systemContext.branch', () => {
    const result = extract({
      systemContext: { branch: 'refs/heads/feature-x', origin: 'watcher' },
    });
    expect(result.anchor?.branch).toBe('feature-x');
    expect(result.anchor?.kind).toBe('branch');
  });
});

// ── Explicit subjectAnchor API field (second precedence) ─────────────────────

describe('extractSubjectAnchor — explicit subjectAnchor API field', () => {
  it('accepts a well-formed explicit subjectAnchor', () => {
    const result = extract({
      subjectAnchor: {
        version: 1,
        kind: 'pull_request',
        prNumber: 55,
        source: 'context',
        confidence: 'exact',
      },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.prNumber).toBe(55);
    expect(result.anchor?.source).toBe('context');
    expect(result.anchor?.confidence).toBe('exact');
  });

  it('subjectAnchor is overridden by systemContext', () => {
    const result = extract({
      subjectAnchor: { version: 1, kind: 'pull_request', prNumber: 55, source: 'context', confidence: 'exact' },
      systemContext: { prNumber: 99, origin: 'webhook' },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.prNumber).toBe(99);
    expect(result.anchor?.source).toBe('system');
  });

  it('subjectAnchor overrides URL-parsed anchor', () => {
    const result = extract({
      title: 'https://github.com/buildd-ai/buildd/pull/5',
      subjectAnchor: { version: 1, kind: 'pull_request', prNumber: 42, source: 'context', confidence: 'exact' },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.prNumber).toBe(42);
  });

  it('normalizes headSha inside the explicit subjectAnchor', () => {
    const sha = 'ABCDEF12345678901234567890123456789012AB';
    const result = extract({
      subjectAnchor: { version: 1, kind: 'pull_request', prNumber: 1, headSha: sha, source: 'context', confidence: 'exact' },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.headSha).toBe(sha.toLowerCase());
  });

  it('rejects an explicit subjectAnchor with invalid headSha', () => {
    const result = extract({
      subjectAnchor: { version: 1, kind: 'pull_request', prNumber: 1, headSha: 'not-hex', source: 'context', confidence: 'exact' },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.headSha).toBeUndefined();
  });
});

// ── PR anchor invariants ─────────────────────────────────────────────────────

describe('extractSubjectAnchor — PR anchor invariants', () => {
  it('a PR anchor requires prNumber; headSha alone does not form a PR anchor', () => {
    const sha = 'abcdef1234567890abcdef1234567890abcdef12';
    const result = extract({ context: { headSha: sha } });
    // headSha without prNumber cannot form a PR anchor
    expect(result.anchor?.kind).not.toBe('pull_request');
  });

  it('sets kind=pull_request when prNumber is present', () => {
    const result = extract({ context: { prNumber: 5 }, workspaceRepo: WS_REPO });
    expect(result.anchor?.kind).toBe('pull_request');
  });

  it('sets kind=error when errorSignature is the only field', () => {
    const result = extract({ context: { frictionSignature: 'timeout' } });
    expect(result.anchor?.kind).toBe('error');
  });

  it('sets kind=branch when only branch is provided', () => {
    const result = extract({ context: { baseBranch: 'dev' } });
    expect(result.anchor?.kind).toBe('branch');
  });

  it('sets kind=mission when only subjectMissionId is provided', () => {
    const missionId = '00000000-0000-0000-0000-000000000001';
    const result = extract({ context: { subjectMissionId: missionId } });
    expect(result.anchor?.kind).toBe('mission');
    expect(result.anchor?.subjectMissionId).toBe(missionId);
  });

  it('pull_request kind takes priority over branch when both prNumber and branch are set', () => {
    const result = extract({
      context: { prNumber: 9, baseBranch: 'feature-x' },
      workspaceRepo: WS_REPO,
    });
    expect(result.anchor?.kind).toBe('pull_request');
    expect(result.anchor?.branch).toBe('feature-x'); // still stored
  });
});

// ── anchor structural invariants ─────────────────────────────────────────────

describe('extractSubjectAnchor — anchor structural invariants', () => {
  it('always sets version: 1', () => {
    const result = extract({ context: { prNumber: 1 }, workspaceRepo: WS_REPO });
    expect(result.anchor?.version).toBe(1);
  });

  it('always sets source and confidence', () => {
    const result = extract({ context: { prNumber: 1 }, workspaceRepo: WS_REPO });
    expect(result.anchor?.source).toBeDefined();
    expect(result.anchor?.confidence).toBeDefined();
  });
});
