/**
 * Title of the `missionNotes` question row `criteria-rearm.ts` posts on
 * escalation. Shared (not just used) by `criteria-rearm.ts`, which writes it,
 * and `MissionFeed.tsx`, which reads it to identify the escalation note
 * without a DB round-trip or a schema column — a plain string match kept in
 * one place so the two can never drift apart.
 *
 * Deliberately in its own file with no server-only imports: `criteria-rearm.ts`
 * pulls in `@buildd/core/db`, which cannot be bundled into `MissionFeed.tsx`
 * ('use client').
 */
export const CRITERIA_ESCALATION_NOTE_TITLE = 'Goal criteria blocked — owner decision needed';
