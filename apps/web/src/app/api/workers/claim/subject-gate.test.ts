import { describe, it, expect } from 'bun:test';
import { PgDialect } from 'drizzle-orm/pg-core';
import { subjectLivenessCondition, subjectStillLive } from './subject-gate';
import {
  BYPASS_SUBJECT_GATE_KEY,
  SUBJECT_BINDING_SOURCES,
  SUBJECT_DEAD_RESOLUTION,
} from '@/lib/subject-gate-contract';

/**
 * The subject gate has two expressions of ONE contract:
 *   - `subjectLivenessCondition()` — SQL prefilter in the claim query
 *   - `subjectStillLive()`         — in-loop guard in the dispatch loop
 * Both read lib/subject-gate-contract.ts, so they cannot drift. These tests
 * assert the TS side behaviourally, assert the SQL side references every
 * contract literal (the chunk walk), and assert what the SQL actually *does*
 * with those literals (the PgDialect render further down — the literal walk
 * alone passed under a fully inverted predicate).
 */

// ─── subjectStillLive ────────────────────────────────────────────────────────

describe('subjectStillLive', () => {
  it('returns true for tasks with no subject anchor (backwards compat)', () => {
    expect(subjectStillLive({ subjectKind: null, subjectPrNumber: null, subjectResolution: null })).toBe(true);
    expect(subjectStillLive({})).toBe(true);
  });

  it('returns true when subject kind is not pull_request', () => {
    for (const kind of ['error', 'mission', 'branch']) {
      expect(subjectStillLive({ subjectKind: kind, subjectResolution: 'reconciled', subjectAnchor: { source: 'system' } })).toBe(true);
    }
  });

  it('returns true for pull_request subject with no PR number', () => {
    expect(subjectStillLive({ subjectKind: 'pull_request', subjectPrNumber: null, subjectResolution: 'reconciled', subjectAnchor: { source: 'system' } })).toBe(true);
  });

  it('returns true for a live subject PR (no resolution yet)', () => {
    expect(subjectStillLive({ subjectKind: 'pull_request', subjectPrNumber: 42, subjectResolution: null, subjectAnchor: { source: 'system' } })).toBe(true);
  });

  it('returns true for attached / superseded / filed_anyway resolutions', () => {
    for (const resolution of ['attached', 'superseded', 'filed_anyway']) {
      expect(subjectStillLive({ subjectKind: 'pull_request', subjectPrNumber: 42, subjectResolution: resolution, subjectAnchor: { source: 'system' } })).toBe(true);
    }
  });

  it('returns false for a reconciled subject with a system/exact anchor (CI retry for a closed PR)', () => {
    expect(subjectStillLive({
      subjectKind: 'pull_request',
      subjectPrNumber: 1789,
      subjectResolution: 'reconciled',
      subjectAnchor: { source: 'system' },
    })).toBe(false);
  });

  it('returns false for a reconciled subject with a context/exact anchor', () => {
    expect(subjectStillLive({
      subjectKind: 'pull_request',
      subjectPrNumber: 1789,
      subjectResolution: 'reconciled',
      subjectAnchor: { source: 'context' },
    })).toBe(false);
  });

  it('REGRESSION (task aeb80f): a reconciled text/derived anchor stays claimable', () => {
    // Description merely mentioned "PR #1789" as background context. That prose
    // mention must never make the task mortal.
    expect(subjectStillLive({
      subjectKind: 'pull_request',
      subjectPrNumber: 1789,
      subjectResolution: 'reconciled',
      subjectAnchor: {
        version: 1,
        kind: 'pull_request',
        prNumber: 1789,
        source: 'text',
        confidence: 'derived',
      } as any,
    })).toBe(true);
  });

  it('a reconciled url/derived anchor stays claimable', () => {
    expect(subjectStillLive({
      subjectKind: 'pull_request',
      subjectPrNumber: 1789,
      subjectResolution: 'reconciled',
      subjectAnchor: { source: 'url' },
    })).toBe(true);
  });

  it('fails OPEN when the subjectAnchor column was not selected (undefined source)', () => {
    // A consumer that forgets to select subject_anchor must not silently
    // re-open the hole — undefined is advisory, not binding.
    expect(subjectStillLive({
      subjectKind: 'pull_request',
      subjectPrNumber: 1789,
      subjectResolution: 'reconciled',
    })).toBe(true);
  });

  it('honors the force-start bypass written by /api/tasks/[id]/start', () => {
    const dead = {
      subjectKind: 'pull_request',
      subjectPrNumber: 1789,
      subjectResolution: 'reconciled',
      subjectAnchor: { source: 'system' },
    };
    expect(subjectStillLive(dead)).toBe(false);
    expect(subjectStillLive({ ...dead, context: { [BYPASS_SUBJECT_GATE_KEY]: true } })).toBe(true);
  });
});

// ─── subjectLivenessCondition (SQL side of the same contract) ────────────────

/**
 * Collect the raw SQL text chunks and bound param values of a drizzle SQL
 * fragment. Column/table objects carry no `value`, so they are skipped — we
 * only want the literals the gate itself contributes.
 */
function sqlLiterals(node: any, out: string[] = []): string[] {
  if (node === null || node === undefined) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const item of node) sqlLiterals(item, out);
    return out;
  }
  if (Array.isArray(node.queryChunks)) {
    sqlLiterals(node.queryChunks, out);
    return out;
  }
  // StringChunk ({ value: string[] }) and Param ({ value: unknown }).
  if ('value' in node) sqlLiterals(node.value, out);
  return out;
}

/**
 * The literal walk above proves the contract values *reach* the fragment, but
 * says nothing about how they are used: every one of these mutations kept the
 * file green —
 *   - dropping the outer `NOT (...)`  → the gate admits ONLY dead-subject tasks
 *   - `subject_pr_number IS NOT NULL` → `IS NULL`
 *   - `source IN (...)`               → `NOT IN (...)`  (advisory anchors become
 *                                        the mortal ones; PR-bound ones don't)
 *   - `confidence != 'derived'`       → `=`  (re-opens the aeb80f incident in
 *                                        SQL while the TS guard still says live)
 *   - `bypassSubjectGate != 'true'`   → `=`  (bypass becomes a self-block)
 *   - `subject_kind = 'pull_request'` → any other kind
 * A prefilter that disagrees with `subjectStillLive()` is the worst shape of
 * this bug: the task is filtered out of the candidate query, so the in-loop
 * guard never runs and the task simply never claims, with no recorded reason.
 */
const dialect = new PgDialect();

function renderSubjectGate(): { text: string; params: unknown[] } {
  const q = dialect.sqlToQuery(subjectLivenessCondition());
  return { text: q.sql.replace(/\s+/g, ' ').trim(), params: q.params };
}

describe('subjectLivenessCondition — emitted SQL', () => {
  it('is a negated conjunction of exactly the six mortality conditions', () => {
    const { text } = renderSubjectGate();
    // Without the outer NOT the predicate selects dead subjects instead of
    // excluding them.
    expect(text.startsWith('NOT (')).toBe(true);
    // All six must hold for a task to be dead. An OR anywhere in here would
    // make e.g. "kind = pull_request" alone enough to kill the task.
    expect(text.split(' AND ')).toHaveLength(6);
    expect(text).not.toContain(' OR ');
  });

  it('only a pull_request subject with a PR number can be mortal', () => {
    const { text } = renderSubjectGate();
    expect(text).toContain(`"tasks"."subject_kind" = 'pull_request'`);
    expect(text).toContain('"tasks"."subject_pr_number" IS NOT NULL');
  });

  it('binds the contract values positionally', () => {
    const { params } = renderSubjectGate();
    expect(params).toEqual([
      SUBJECT_DEAD_RESOLUTION,
      ...SUBJECT_BINDING_SOURCES,
      'derived',
      BYPASS_SUBJECT_GATE_KEY,
    ]);
  });

  it('treats binding sources as the mortal set, never the exempt set', () => {
    const { text } = renderSubjectGate();
    expect(text).toMatch(/COALESCE\("tasks"\."subject_anchor"->>'source', ''\) IN \(\$2, \$3\)/);
    expect(text).not.toContain('NOT IN');
  });

  it('excludes derived-confidence anchors and honours the bypass', () => {
    const { text } = renderSubjectGate();
    // `!=` → `=` on either of these inverts it: an anchor the filer marked as
    // inferred becomes the only mortal one, and setting the bypass flag becomes
    // the thing that blocks the task.
    expect(text).toMatch(/COALESCE\("tasks"\."subject_anchor"->>'confidence', ''\) != \$4/);
    expect(text).toMatch(/COALESCE\("tasks"\."context"->>\$5, ''\) != 'true'/);
  });
});

describe('subjectLivenessCondition', () => {
  it('returns a SQL fragment', () => {
    const cond = subjectLivenessCondition();
    expect(cond).toBeDefined();
    expect(typeof cond).toBe('object');
  });

  it('references every contract literal — SQL and TS cannot drift', () => {
    const literals = sqlLiterals(subjectLivenessCondition());

    // The dead-resolution sentinel and the bypass key.
    expect(literals).toContain(SUBJECT_DEAD_RESOLUTION);
    expect(literals).toContain(BYPASS_SUBJECT_GATE_KEY);

    // Every binding source is enumerated in the SQL IN(...) list.
    for (const source of SUBJECT_BINDING_SOURCES) {
      expect(literals).toContain(source);
    }

    // Non-binding sources must NOT appear — their presence would mean the SQL
    // gate blocks anchors the TS gate considers advisory.
    expect(literals).not.toContain('text');
    expect(literals).not.toContain('url');
    expect(literals).not.toContain('backfill');
  });
});
