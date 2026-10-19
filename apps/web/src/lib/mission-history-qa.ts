/**
 * Deterministic History events for the visual-QA capture (`?qaHistory=1` on a
 * mission's feed layout, development builds only). The sandbox clone has no
 * guaranteed mission activity, so the capture plan cannot rely on real events:
 * these two notes produce an escalation and its answer, which both lenses
 * (Highlights and All activity) render as event rows.
 */
import type { FeedNoteInput } from './mission-event-feed';

const QA_AT = Date.UTC(2026, 0, 15, 9, 0, 0);

export const QA_HISTORY_NOTES: readonly FeedNoteInput[] = [
  { id: 'qa-history-question', type: 'question', authorType: 'agent', title: 'Keep the retry window at four hours?', taskId: null, createdAt: QA_AT },
  { id: 'qa-history-answer', type: 'reply', authorType: 'user', title: 'Yes, keep four hours', taskId: null, createdAt: QA_AT + 5 * 60_000 },
];

/** The fixture applies only to a development build asking for it. */
export function qaHistoryNotes(param: string | undefined, nodeEnv: string | undefined): readonly FeedNoteInput[] | null {
  return param === '1' && nodeEnv === 'development' ? QA_HISTORY_NOTES : null;
}
