'use client';

/**
 * What the layout's NeedsInputProvider publishes: the tasks waiting on the
 * person, and the hook an answer surface uses to mark one answered.
 */
import { createContext, useContext } from 'react';

export interface WaitingTask {
  id: string;
  title: string;
  workspaceId: string;
  /** The task's mission, so a link can open it in mission context. */
  missionId?: string | null;
  waitingFor: { type: string; prompt: string; options?: string[]; context?: string; recommended?: { label: string; reason?: string } } | null;
  /** Answered; the worker has not picked the answer up yet. Not counted as waiting. */
  answerSent?: boolean;
}

export type AlertPermission = NotificationPermission | 'unsupported';

export interface NeedsInputContextValue {
  /** Waiting tasks, and answered ones whose worker has not resumed (`answerSent`). */
  tasks: WaitingTask[];
  /** Tasks that still need the person: `answerSent` ones excluded. */
  count: number;
  /** Browser notification permission; 'default' means the user hasn't been asked. */
  alertPermission: AlertPermission;
  /** Ask for notification permission. Must run from a user gesture (the 'Enable alerts' control). */
  enableAlerts: () => void;
  /** The person just answered this task's question: read it as sent until the worker resumes. */
  markAnswerSent?: (taskId: string) => void;
}

export const NeedsInputContext = createContext<NeedsInputContextValue>({
  tasks: [],
  count: 0,
  alertPermission: 'unsupported',
  enableAlerts: () => {},
  markAnswerSent: () => {},
});

export function useNeedsInput() {
  return useContext(NeedsInputContext);
}
