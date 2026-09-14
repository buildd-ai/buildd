import { describe, it, expect } from 'bun:test';
import {
  docFixTaskTitle,
  proposalChildTaskTitle,
  buildDocFixTaskDescription,
  buildProposalChildDescription,
} from '../spec-doc-fix';

const SPEC = 'docs/design/runner-oauth-broker.md';
const ASSERTIONS = [
  { assertionId: 'broker-daemon', detail: 'symbol BrokerDaemon found' },
  { assertionId: 'broker-route', detail: null },
];

describe('docFixTaskTitle', () => {
  it('names the document, so the task is identifiable without opening it', () => {
    expect(docFixTaskTitle(SPEC)).toContain(SPEC);
  });
});

describe('buildDocFixTaskDescription', () => {
  const body = buildDocFixTaskDescription({ specPath: SPEC, assertions: ASSERTIONS });

  it('names every assertion it is discharging', () => {
    expect(body).toContain('broker-daemon');
    expect(body).toContain('broker-route');
  });

  it('carries the checker evidence where there is any, and does not fake it where there is none', () => {
    expect(body).toContain('symbol BrokerDaemon found');
    expect(body).toContain('- `broker-route`\n');
  });

  it('covers both halves of the reconciliation: the status AND renamed claim text', () => {
    expect(body).toMatch(/status frontmatter/i);
    expect(body).toMatch(/renamed or\s+moved/);
    expect(body).toMatch(/Case 1/);
  });

  it('says the PR is docs-only and independently mergeable', () => {
    expect(body).toMatch(/docs-only/);
    expect(body).toMatch(/reviewable and mergeable on/);
  });

  it('forbids the worker closing the ledger rows — closure is the checker\'s, not the agent\'s', () => {
    expect(body).toContain('Do not close the ledger rows');
    expect(body).toMatch(/re-run of the conformance checker does/);
  });

  it('asks for a proposal only if there is one, and says an empty one is the expected outcome', () => {
    expect(body).toMatch(/Optional: propose net-enhancement code work/);
    expect(body).toMatch(/Having nothing to propose is the expected outcome/);
    expect(body).toMatch(/Return no plan at all/);
  });

  it('pins the five fields every proposal item must carry', () => {
    for (const field of [
      'Spec clause', 'Observed gap', 'Proposed change', 'Why a net enhancement', 'Estimated size',
    ]) {
      expect(body).toContain(field);
    }
  });

  it('says nothing proposed is dispatched without a human — spec before code', () => {
    expect(body).toMatch(/Record them — do not build them/);
    expect(body).toMatch(/nothing you\s+propose here is dispatched without a human approving it first/);
  });

  it('asks for exactly one plan step, so approving is one decision that mints one task', () => {
    expect(body).toMatch(/\*\*exactly one\*\* step/);
  });
});

describe('buildProposalChildDescription', () => {
  const body = buildProposalChildDescription({
    specPath: SPEC,
    assertionIds: ['broker-daemon', 'broker-route'],
    proposal: '### Refresh proactively\n\nGap: only on 401.',
  });

  it('carries the approved proposal verbatim — the human approved that text, not a re-summary', () => {
    expect(body).toContain('### Refresh proactively');
    expect(body).toContain('Gap: only on 401.');
  });

  it('requires the spec to be finalized in the SAME PR as the code', () => {
    expect(body).toContain(SPEC);
    expect(body).toMatch(/same PR/);
    expect(body).toMatch(/re-opens the\s+discrepancy/);
  });

  it('names the assertions the finished state has to describe', () => {
    expect(body).toContain('broker-daemon');
    expect(body).toContain('broker-route');
  });

  it('tells the worker to stop rather than build something adjacent when the proposal is wrong', () => {
    expect(body).toMatch(/stop and report why/);
  });

  it('omits the assertion line rather than printing an empty one', () => {
    const none = buildProposalChildDescription({ specPath: SPEC, assertionIds: [], proposal: 'x' });
    expect(none).not.toMatch(/assertions this touches/);
  });
});

describe('proposalChildTaskTitle', () => {
  it('names the document being finalized', () => {
    expect(proposalChildTaskTitle(SPEC)).toContain(SPEC);
  });
});
