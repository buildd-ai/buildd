/**
 * buildd's side of the findings model (docs/specs/workflow-kernel-library.md §5):
 * what the kernel reads off a reviewer's output and what the reviewer is told.
 * The activity comment lists no findings (Living Spec fa62b865 R-51).
 */
import { describe, expect, test } from 'bun:test';
import { verdictFindingsOf } from './seam';
import { findingsSection } from '@/lib/reviewer';


describe('verdictFindingsOf: the reviewer output the kernel reads', () => {
  test('fa62b865 R-44 / R-46: a finding keeps who can fix it, and an evidence finding what buildd captures', () => {
    expect(verdictFindingsOf({
      findings: [
        { title: 'compare s1', remedyClass: 'evidence', evidence: { criterionId: 'AC-1', screen: 's1', route: '/app/x' } },
        { title: 'which tier?', remedyClass: 'person_decision' },
        { title: 'odd class', remedyClass: 'vibes', path: 'a.ts' },
      ],
    }).findings).toEqual([
      { path: null, line: null, title: 'compare s1', remedyClass: 'evidence', evidence: { screen: 's1', criterionId: 'AC-1', route: '/app/x' } },
      { path: null, line: null, title: 'which tier?', remedyClass: 'person_decision' },
      { path: 'a.ts', line: null, title: 'odd class' },
    ]);
  });

  test('findings, resolutions and deferrals pass through; malformed entries are dropped', () => {
    expect(verdictFindingsOf({
      verdict: 'request-changes',
      findings: [{ path: 'a.ts', line: 3.7, title: ' fix it ' }, { title: '' }, 'junk', { id: 'r1:0', title: 'again', required: false }],
      resolvedFindings: ['r1:1', '', 7],
      deferredFindings: [{ id: 'r1:2', reason: 'docs task', taskId: 't9' }, { id: 'r1:3' }],
    })).toEqual({
      findings: [{ path: 'a.ts', line: 3, title: 'fix it' }, { id: 'r1:0', path: null, line: null, title: 'again', required: false }],
      resolvedFindings: ['r1:1'],
      deferredFindings: [{ id: 'r1:2', reason: 'docs task', taskId: 't9' }],
    });
  });
  test('an output without the keys leaves them absent: an older reviewer\'s approval verifies everything', () => {
    expect(verdictFindingsOf({ verdict: 'approve', confidence: 0.9, summary: 'ok' })).toEqual({});
    expect(verdictFindingsOf(null)).toEqual({});
  });
});

describe('findingsSection: what the reviewer is told', () => {
  test('always says how to report findings; lists each open one with its id, flagging the ones to verify', () => {
    expect(findingsSection(undefined)).toContain('list each distinct issue in `findings`');
    const s = findingsSection({ open: [{ id: 'r1:0', path: 'src/a.ts', line: 4, title: 'rename the flag', status: 'addressed' }], verify: ['r1:0'] });
    expect(s).toContain('- `r1:0` (verify this one) (a push touched its file): `src/a.ts:4` rename the flag');
    expect(s).toContain('An approve that leaves one of them unlisted does not approve this head.');
  });
});

