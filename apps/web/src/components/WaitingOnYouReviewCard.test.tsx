import { describe, it, expect } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { WaitingOnYouReviewCard } from './WaitingOnYouReviewCard';
import type { ActionQueueItem } from '@/lib/action-queue';

function item(partial: Partial<ActionQueueItem> = {}): ActionQueueItem {
  return {
    subjectKey: 'https://github.com/org/repo/pull/2054',
    chip: 'REVIEW',
    prUrl: 'https://github.com/org/repo/pull/2054',
    prNumber: 2054,
    taskId: 'task-2',
    taskTitle: '[WU-2] Health tab restructure',
    workspaceId: 'ws-1',
    workspaceName: 'buildd',
    ...partial,
  };
}

describe('WaitingOnYouReviewCard mission context', () => {
  it('shows the mission the review unblocks', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({ missionId: 'mis-2', missionTitle: 'Health analytics restructure' })}
      />,
    );
    expect(html).toContain('Health analytics restructure');
    expect(html).toContain('/app/missions/mis-2');
  });

  it('marks a mission-less card as unlinked work', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard item={item({ workspaceName: '__coordination' })} />,
    );
    expect(html).toContain('No mission · __coordination');
  });
});

describe('WaitingOnYouReviewCard recommendation', () => {
  it('shows what the reviewer said to do next', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Touches the token refresh path',
          recommendation: 'Confirm the refresh lock by hand, then merge.',
        })}
      />,
    );
    expect(html).toContain('Agent recommends:');
    expect(html).toContain('Confirm the refresh lock by hand, then merge.');
  });

  it('stays quiet when there is no recommendation', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard item={item({ escalationReason: 'Touches auth' })} />,
    );
    expect(html).not.toContain('Agent recommends');
    expect(html).not.toContain('No handoff recommendation');
  });
});

describe('WaitingOnYouReviewCard action hierarchy', () => {
  it('offers Apply / Apply with corrections / Merge anyway, with Apply as the filled primary action', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({ escalationReason: 'Touches schema.ts', recommendation: 'Guard the null-overwrite.' })}
      />,
    );
    expect(html).toContain('>Apply<');
    expect(html).toContain('Apply with corrections');
    expect(html).toContain('Merge anyway');
    // Apply is the filled/primary button (bg-accent); Merge anyway is a bare text link.
    const applyIdx = html.indexOf('>Apply<');
    const mergeAnywayIdx = html.indexOf('Merge anyway');
    expect(applyIdx).toBeGreaterThan(-1);
    expect(mergeAnywayIdx).toBeGreaterThan(applyIdx);
  });

  it('renders no action row when the card has no PR (nothing to apply to or merge)', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard item={item({ prNumber: undefined })} />,
    );
    expect(html).not.toContain('Apply with corrections');
    expect(html).not.toContain('Merge anyway');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The CTA set derives from server state exactly like the rendered text does
// (I-1 in docs/specs/action-queue-card-state.md, extended to cover the CTA set
// as well as the copy). Apply / Apply-with-corrections exist ONLY when the
// server sent a recommendation — anything else is dead by construction and
// must not be rendered at all, let alone as the primary action. Every state
// audited for this fix pins its expected CTA set here so a future change
// cannot silently reintroduce a dead button.
// ─────────────────────────────────────────────────────────────────────────────
describe('WaitingOnYouReviewCard — CTA set derives from server state, per reviewer outcome', () => {
  function ctas(html: string) {
    return {
      apply: html.includes('>Apply<'),
      applyWithCorrections: html.includes('Apply with corrections'),
      mergeAnywayLink: html.includes('Merge anyway'),
      mergePrimary: /class="[^"]*bg-accent[^"]*"[^>]*>\s*Merge\s*</.test(html),
      reReview: html.includes('Re-review'),
    };
  }

  it('escalate, with a recommendation: Apply / Apply-with-corrections primary, Merge demoted to a footer link (regression)', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({ escalationReason: 'Touches schema.ts', recommendation: 'Guard the null-overwrite.' })}
      />,
    );
    expect(ctas(html)).toEqual({
      apply: true,
      applyWithCorrections: true,
      mergeAnywayLink: true,
      mergePrimary: false,
      reReview: false,
    });
  });

  it('review_failed: no Apply, Merge is primary, Re-review offered, reason stated plainly', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({ escalationReason: 'Reviewer task failed — needs human review' })}
      />,
    );
    expect(ctas(html)).toEqual({
      apply: false,
      applyWithCorrections: false,
      mergeAnywayLink: false,
      mergePrimary: true,
      reReview: true,
    });
    expect(html).toContain('Reviewer task failed — needs human review');
  });

  it('reviewer task cancelled: same CTA set as review_failed', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({ escalationReason: 'Reviewer task cancelled — needs human review' })}
      />,
    );
    expect(ctas(html)).toEqual({
      apply: false,
      applyWithCorrections: false,
      mergeAnywayLink: false,
      mergePrimary: true,
      reReview: true,
    });
  });

  it('request-changes exhausted: an open escalation note exists but carries no recommendation — dispatch-fix, not Merge/Re-review', () => {
    // Superseded by the fix-dispatch rule below: escalateReviewerExhaustion DOES
    // write a real reviewer_escalated note (see hasEscalationNote), so this is
    // dispatchable off its free-text reason, unlike a pure no-verdict inference.
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Reviewer requested changes 3 times — automated fix attempts exhausted. Human review required.',
          recommendation: null,
          hasEscalationNote: true,
        })}
      />,
    );
    expect(ctas(html)).toEqual({
      apply: false,
      applyWithCorrections: false,
      mergeAnywayLink: true,
      mergePrimary: false,
      reReview: false,
    });
    expect(html).toContain('Dispatch fix');
  });

  it('no reviewer task exists (stalled past the grace period): same CTA set as review_failed', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'No reviewer task recorded · PR waiting 45m · seats unknown · budget pause unknown · claimable: not yet diagnosed',
        })}
      />,
    );
    expect(ctas(html)).toEqual({
      apply: false,
      applyWithCorrections: false,
      mergeAnywayLink: false,
      mergePrimary: true,
      reReview: true,
    });
  });

  it('approved under an approve-only gate: no Apply, Merge is primary, no Re-review — nothing failed, there is nothing to redo', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Reviewer approved — awaiting human merge',
          verdictSummary: 'Looks good, confidence 0.92',
        })}
      />,
    );
    expect(ctas(html)).toEqual({
      apply: false,
      applyWithCorrections: false,
      mergeAnywayLink: false,
      mergePrimary: true,
      reReview: false,
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// An escalation carrying a concrete defect statement but no reviewer
// recommendation still gets a dispatch CTA — the gap this fix closes. The
// discriminator is `hasEscalationNote`: a genuine open reviewer_escalated note
// exists (an agent handed the PR back with something to act on), as opposed
// to resolveReviewerGate synthesizing a reason from pure task-status
// inference (review_failed, cancelled, no reviewer task — covered above,
// unaffected since those never set hasEscalationNote).
// ─────────────────────────────────────────────────────────────────────────────
describe('WaitingOnYouReviewCard — escalation with a concrete defect but no recommendation', () => {
  function ctas(html: string) {
    return {
      dispatchFix: html.includes('>Dispatch fix<'),
      dispatchFixWithCorrections: html.includes('Dispatch fix with corrections'),
      mergeAnywayLink: html.includes('Merge anyway'),
      mergePrimary: /class="[^"]*bg-accent[^"]*"[^>]*>\s*Merge\s*</.test(html),
      reReview: html.includes('>Re-review<'),
    };
  }

  it('spec-conformance escalation (schema changed without a generated migration): Dispatch fix is primary, Merge demoted, no plain Re-review', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Spec conformance: the discrepancy ledger schema changed without a generated SQL migration',
          recommendation: null,
          hasEscalationNote: true,
        })}
      />,
    );
    expect(ctas(html)).toEqual({
      dispatchFix: true,
      dispatchFixWithCorrections: true,
      mergeAnywayLink: true,
      mergePrimary: false,
      reReview: false,
    });
    expect(html).toContain('Spec conformance: the discrepancy ledger schema changed without a generated SQL migration');
  });

  it('regression: an escalation-shaped reason with NO open note (e.g. a stall/no-task inference) still gets plain Merge + Re-review, not dispatch', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'No reviewer will run for this PR — manual merge required',
          recommendation: null,
          hasEscalationNote: false,
        })}
      />,
    );
    expect(ctas(html)).toEqual({
      dispatchFix: false,
      dispatchFixWithCorrections: false,
      mergeAnywayLink: false,
      mergePrimary: true,
      reReview: true,
    });
  });

  it('regression: escalate-with-recommendation still renders Apply, not Dispatch fix, even if hasEscalationNote is also true', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Touches schema.ts',
          recommendation: 'Guard the null-overwrite.',
          hasEscalationNote: true,
        })}
      />,
    );
    expect(html).toContain('>Apply<');
    expect(html).not.toContain('Dispatch fix');
  });

  it('dead-zone exhausted conflict retries take priority over a stale escalation note — no dispatch CTA', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: '3 conflict-resolution attempts failed — human action required',
          recommendation: null,
          hasEscalationNote: true,
          deadZoneExhausted: true,
        })}
      />,
    );
    expect(html).not.toContain('Dispatch fix');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// "Re-review changes since approval" — offered whenever a terminal verdict
// (approve OR escalate) exists but the PR's head has since moved past the SHA
// it was made against. Head === approvedSha must never offer it: a re-review
// against an empty diff has nothing new to say.
// ─────────────────────────────────────────────────────────────────────────────
describe('WaitingOnYouReviewCard — Re-review changes since approval', () => {
  it('offers it on an approved PR whose head has advanced past the verdict', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Reviewer approved — awaiting human merge',
          verdictSummary: 'Looks good, confidence 0.92',
          approvedSha: 'old-sha',
          headSha: 'new-sha',
        })}
      />,
    );
    expect(html).toContain('Re-review changes since approval');
  });

  it('does NOT offer it when the head equals the verdict SHA', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Reviewer approved — awaiting human merge',
          verdictSummary: 'Looks good, confidence 0.92',
          approvedSha: 'same-sha',
          headSha: 'same-sha',
        })}
      />,
    );
    expect(html).not.toContain('Re-review changes since approval');
  });

  it('offers it on an escalated PR (with a recommendation) whose head has advanced', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Touches schema.ts',
          recommendation: 'Guard the null-overwrite.',
          approvedSha: 'old-sha',
          headSha: 'new-sha',
        })}
      />,
    );
    expect(html).toContain('Re-review changes since approval');
    // Apply/Apply-with-corrections/Merge anyway stay exactly as before.
    expect(html).toContain('>Apply<');
    expect(html).toContain('Merge anyway');
  });

  it('does not offer it when there is no verdict at all, even with mismatched SHAs (plain Re-review already covers that state)', () => {
    const html = renderToStaticMarkup(
      <WaitingOnYouReviewCard
        item={item({
          escalationReason: 'Reviewer task failed — needs human review',
          approvedSha: 'old-sha',
          headSha: 'new-sha',
        })}
      />,
    );
    expect(html).not.toContain('Re-review changes since approval');
    // Plain Re-review is still there for the no-verdict state.
    expect(html).toContain('>Re-review<');
  });
});
