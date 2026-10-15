/**
 * buildd's side of the findings model (docs/specs/workflow-kernel-library.md §5):
 * what the kernel reads off a reviewer's output, what the reviewer is told, and
 * how the activity comment lists findings with their disposition.
 */
import { describe, expect, test } from 'bun:test';
import { verdictFindingsOf } from './seam';
import { renderFindingsSummary } from './pr-activity-render';
import { findingsSection } from '@/lib/reviewer';
import type { FindingSnapshot, RoundSnapshot } from './types';

const F = (o: Partial<FindingSnapshot> = {}): FindingSnapshot => ({
  id: 'r1:0', originRoundId: 'r1', originRound: 1, originHeadSha: 'H1', ordinal: 0, path: 'src/a.ts', line: 4, title: 'rename the flag',
  required: true, status: 'open', lastRound: 1, addressedBySha: null, closedByRoundId: null, closedBy: null, closedReason: null,
  deferredToTaskId: null, ...o,
});
const round = (id: string, n: number): RoundSnapshot => ({ id, round: n, headSha: 'H', kind: 'full', status: 'decided', verdict: 'approve', effectiveVerdict: 'approve', failureCount: 0 });

describe('verdictFindingsOf: the reviewer output the kernel reads', () => {
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

describe('renderFindingsSummary: the activity comment', () => {
  test('nothing when there are no findings', () => {
    expect(renderFindingsSummary({ findings: [], rounds: [] })).toBe('');
  });
  test('each finding with its disposition, the commit that addressed it and the round that verified it', () => {
    const out = renderFindingsSummary({
      rounds: [round('r1', 1), round('r3', 3)],
      findings: [
        F({ status: 'resolved', addressedBySha: 'abcdef1234', closedByRoundId: 'r3' }),
        F({ id: 'r1:1', path: null, line: null, title: 'add a <test> for @someone', status: 'addressed', addressedBySha: '1234567890' }),
        F({ id: 'r1:2', path: 'b.ts', line: null, title: 'typo', status: 'waived', closedBy: 'human:owner', closedReason: 'fine as is' }),
        F({ id: 'r2:0', originRound: 2, path: 'c.ts', title: 'docs', required: false, status: 'deferred', deferredToTaskId: '9a8b7c6d-0000', closedReason: 'docs slice' }),
      ],
    });
    expect(out.split('\n')).toEqual([
      '<details><summary>Findings: 1 open of 4</summary>',
      '',
      '- `src/a.ts:4` rename the flag (round 1) · resolved by `abcdef1`, verified in round 3',
      '- add a &lt;test&gt; for @​someone (round 1) · addressed by `1234567`, awaiting verification',
      '- `b.ts` typo (round 1) · waived by owner: fine as is',
      '- `c.ts:4` docs (round 2, optional) · deferred to task 9a8b7c6d: docs slice',
      '',
      '</details>',
    ]);
  });
});
