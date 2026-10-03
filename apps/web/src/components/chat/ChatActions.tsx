'use client';

/**
 * What a card in the feed can do to the conversation, without knowing whether
 * it is wired to `useChat` or to the fixtures page.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { VisualReviewDecisionRequest, VisualReviewDecisionResponse, VisualReviewUndoResponse } from '@buildd/shared';
import type { BuilddObjectRef } from './chat-contract';
import { submitAnswer, type AnswerOutcome } from '@/app/app/(protected)/tasks/[id]/respond/submit-answer';
import { createHttpVisualReviewTransport } from '@/components/visual-review/review-transport';

/** A human decision on audit screens, as the decisions route takes it (plus the mission). */
export type ReviewShotsInput = VisualReviewDecisionRequest & { missionId: string };

/** The visual review the dock or sheet is showing: the mission, and the screen to open on. */
export interface OpenVisualReview {
  ref: BuilddObjectRef;
  /** A cell key; null opens on the head of the queue. */
  startKey: string | null;
  /**
   * Which surface shows the deck: the sheet (phone and tablet) or the desktop
   * dock. Both can be mounted at once (CSS hides the other), so exactly one
   * renders the deck, and its keys and swipes act once.
   */
  surface: 'sheet' | 'dock';
}

export interface ChatActions {
  /** Answer an approval part: echoes the approval id back (`addToolApprovalResponse`). */
  respondToApproval(approvalId: string, approved: boolean, reason?: string): void;
  /** Put text in the composer and focus it (the approval card's Edit). */
  prefillComposer(text: string): void;
  /** Open an object in the docked pane (desktop) or the sheet (phone), and pin it. */
  openObject(ref: BuilddObjectRef): void;
  /** Display name for a workspace id, when the surface knows it. */
  workspaceName(id: string): string | null;
  /** The signed-in user's first name, for "approved by …". */
  viewerName: string | null;
  /** The ref the pane is showing, so its inline card can say so. */
  paneRef: BuilddObjectRef | null;
  /**
   * Answer a waiting agent — the respond route by default. Tapping an option is
   * the approval. Resolves with what was recorded (an already-answered question
   * resolves too, it is not an error); a fixture may resolve with nothing.
   */
  answerQuestion(input: { workerId: string; taskId: string; noteId: string | null; message: string }): Promise<AnswerOutcome | void>;
  /**
   * Record a human decision on audit screens: the decisions route, directly.
   * The tap is the consent (as for answerQuestion); no approval card, and no
   * assistant tool reaches it. Rejects with the route's error (409 stale
   * carries the fresh model).
   */
  reviewShots(input: ReviewShotsInput): Promise<VisualReviewDecisionResponse>;
  /** Undo one decision (the decisions route's DELETE). */
  undoReview(input: { missionId: string; reviewId: string }): Promise<VisualReviewUndoResponse>;
  /** Open a mission's review deck: in the docked pane on desktop, in the sheet on a phone. */
  openVisualReview(ref: BuilddObjectRef, startKey?: string | null): void;
  /** The review deck open now, if any. */
  visualReview: OpenVisualReview | null;
  closeVisualReview(): void;
}

const noop = () => {};
const DEFAULT: ChatActions = {
  respondToApproval: noop,
  prefillComposer: noop,
  openObject: noop,
  workspaceName: () => null,
  viewerName: null,
  paneRef: null,
  answerQuestion: (input) => submitAnswer(input),
  reviewShots: ({ missionId, ...req }) => createHttpVisualReviewTransport(missionId).decide(req),
  undoReview: ({ missionId, reviewId }) => createHttpVisualReviewTransport(missionId).undo(reviewId),
  openVisualReview: noop,
  visualReview: null,
  closeVisualReview: noop,
};

export const DEFAULT_CHAT_ACTIONS: ChatActions = DEFAULT;

const Ctx = createContext<ChatActions>(DEFAULT);

export function ChatActionsProvider({ value, children }: { value: ChatActions; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChatActions(): ChatActions {
  return useContext(Ctx);
}
