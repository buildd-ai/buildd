'use client';

/**
 * What a card in the feed can do to the conversation, without knowing whether
 * it is wired to `useChat` or to the fixtures page.
 */
import { createContext, useContext, type ReactNode } from 'react';
import type { BuilddObjectRef } from './chat-contract';
import { submitAnswer } from '@/app/app/(protected)/tasks/[id]/respond/submit-answer';

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
  /** Answer a waiting agent — the respond route by default. Tapping an option is the approval. */
  answerQuestion(input: { workerId: string; taskId: string; noteId: string | null; message: string }): Promise<void>;
}

const noop = () => {};
const DEFAULT: ChatActions = {
  respondToApproval: noop,
  prefillComposer: noop,
  openObject: noop,
  workspaceName: () => null,
  viewerName: null,
  paneRef: null,
  answerQuestion: async (input) => { await submitAnswer(input); },
};

export const DEFAULT_CHAT_ACTIONS: ChatActions = DEFAULT;

const Ctx = createContext<ChatActions>(DEFAULT);

export function ChatActionsProvider({ value, children }: { value: ChatActions; children: ReactNode }) {
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useChatActions(): ChatActions {
  return useContext(Ctx);
}
