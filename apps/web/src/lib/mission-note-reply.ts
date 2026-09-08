import { CRITERIA_ESCALATION_NOTE_TITLE } from './criteria-escalation-note';

/**
 * Whether MissionFeed should show Reply/Skip for this note.
 *
 * The goal-criteria escalation note is deliberately excluded: its generic
 * reply flow flips `status` to 'answered' without touching
 * `criteriaEscalatedAt` or re-enabling the schedule, which would mute the
 * card while leaving the mission stood down forever — a dressed-up no-op,
 * not a resolution. Its three real exits (file the work / fix the criterion
 * / waive) live on the mission-detail decision sheet and route through
 * `resolveCriteriaEscalation`, which genuinely clears it.
 */
export function isReplyableQuestion(note: { type: string; status: string; title: string }): boolean {
  return note.type === 'question' && note.status === 'open' && note.title !== CRITERIA_ESCALATION_NOTE_TITLE;
}
