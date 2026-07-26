type ReviewerNote = {
  taskId: string | null;
  type: string;
  title: string;
  body: string | null;
  status: string;
  createdAt?: Date | null;
};

const GATE_EVIDENCE_PATTERN =
  /(?:gate condition|auto-merge blocked|awaiting human merge)/i;

function noteText(note: ReviewerNote): string {
  return note.body ?? note.title;
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
      [...escalations].map(([taskId, note]) => [
        taskId,
        { reason: noteText(note), notedAt: note.createdAt ?? new Date(0) },
      ]),
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
