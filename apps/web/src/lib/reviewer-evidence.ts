type ReviewerNote = {
  taskId: string | null;
  type: string;
  title: string;
  body: string | null;
  status: string;
  createdAt?: Date | null;
};

/**
 * Separator the reviewer verdict handler uses to append its recommendation to a
 * note body. Kept in one place so the writer and this reader cannot drift.
 */
export const RECOMMENDATION_MARKER = '\n\n**Recommended next step:** ';

const GATE_EVIDENCE_PATTERN =
  /(?:gate condition|auto-merge blocked|awaiting human merge)/i;

function noteText(note: ReviewerNote): string {
  return note.body ?? note.title;
}

/** Splits a note body into its reason and the reviewer's recommended next step. */
function splitRecommendation(text: string): { reason: string; recommendation: string | null } {
  const idx = text.indexOf(RECOMMENDATION_MARKER);
  if (idx === -1) return { reason: text, recommendation: null };
  const recommendation = text.slice(idx + RECOMMENDATION_MARKER.length).trim();
  return {
    reason: text.slice(0, idx).trim(),
    recommendation: recommendation.length > 0 ? recommendation : null,
  };
}

function isGateEvidence(note: ReviewerNote): boolean {
  return GATE_EVIDENCE_PATTERN.test(`${note.title}\n${note.body ?? ''}`);
}

function isNewer(candidate: ReviewerNote, current: ReviewerNote): boolean {
  return (candidate.createdAt?.getTime() ?? 0) > (current.createdAt?.getTime() ?? 0);
}

export function selectReviewerEvidence(notes: ReviewerNote[]) {
  const escalations = new Map<string, ReviewerNote>();
  const approvals = new Map<string, ReviewerNote>();
  const supersededTaskIds = new Set<string>();

  for (const note of notes) {
    if (!note.taskId) continue;
    if (note.status === 'superseded') {
      supersededTaskIds.add(note.taskId);
      continue;
    }
    if (note.status !== 'open') continue;

    if (note.type === 'reviewer_escalated') {
      const current = escalations.get(note.taskId);
      if (!current || isNewer(note, current)) escalations.set(note.taskId, note);
    }

    if (note.type === 'reviewer_approved') {
      const current = approvals.get(note.taskId);
      if (
        !current ||
        (isGateEvidence(note) && !isGateEvidence(current)) ||
        (isGateEvidence(note) === isGateEvidence(current) && isNewer(note, current))
      ) {
        approvals.set(note.taskId, note);
      }
    }
  }

  return {
    escalationMap: new Map(
      [...escalations].map(([taskId, note]) => {
        const { reason, recommendation } = splitRecommendation(noteText(note));
        return [taskId, { reason, recommendation, notedAt: note.createdAt ?? new Date(0) }] as const;
      }),
    ),
    approvalMap: new Map(
      [...approvals].map(([taskId, note]) => [
        taskId,
        { summary: noteText(note), notedAt: note.createdAt ?? new Date(0) },
      ]),
    ),
    supersededTaskIds,
  };
}
