'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { bindChannelEvents, CHANNEL_PREFIX } from '@/lib/pusher-client';
import { needsInputEventAction } from '@/lib/realtime-throttle';
import { subscribeCatchUp } from '@/lib/app-freshness';
import { taskAnswerHref } from '@/lib/mission-task-href';
import { questionNotificationText } from '@buildd/core/question-brief';

import { NeedsInputContext, type AlertPermission, type WaitingTask } from './needs-input-context';

// The context lives in its own module so an answer surface can mark a task
// answered without importing this provider (and its Pusher wiring).
export { NeedsInputContext, useNeedsInput } from './needs-input-context';

interface Props {
  workspaceIds: string[];
  children: React.ReactNode;
}

function readAlertPermission(): AlertPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
}

export function NeedsInputProvider({ workspaceIds, children }: Props) {
  const [tasks, setTasks] = useState<WaitingTask[]>([]);
  const [alertPermission, setAlertPermission] = useState<AlertPermission>('unsupported');
  const prevTaskIdsRef = useRef<Set<string>>(new Set());
  const initialFetchDone = useRef(false);
  const router = useRouter();

  // Fetch waiting-input tasks. The server keeps the answer 30 s per user;
  // `fresh` is for an event that says a task started or stopped waiting.
  const fetchWaitingTasks = useCallback(async (fresh = false) => {
    try {
      const res = await fetch(fresh ? '/api/tasks/waiting-input?fresh=1' : '/api/tasks/waiting-input');
      if (res.ok) {
        const data = await res.json();
        const newTasks: WaitingTask[] = data.tasks || [];
        setTasks(newTasks);

        // Show toast for newly added tasks (not on initial load)
        if (initialFetchDone.current) {
          const prevIds = prevTaskIdsRef.current;
          for (const task of newTasks) {
            if (!prevIds.has(task.id) && !task.answerSent) {
              showToast(task, router);
            }
          }
        }
        initialFetchDone.current = true;
        prevTaskIdsRef.current = new Set(newTasks.map(t => t.id));
      }
    } catch {
      // Silently fail - not critical
    }
  }, [router]);

  // Initial fetch. Notification permission is NOT requested here — browsers
  // ignore (and some penalise) prompts without a user gesture; see enableAlerts.
  useEffect(() => {
    fetchWaitingTasks();
    setAlertPermission(readAlertPermission());
  }, [fetchWaitingTasks]);

  const enableAlerts = useCallback(() => {
    if (typeof Notification === 'undefined') return;
    Notification.requestPermission()
      .then(setAlertPermission)
      .catch(() => {});
  }, []);

  // Backstop for events missed while the tab was hidden or the socket was
  // down: the shell's freshness coordinator decides when (lib/app-freshness.ts),
  // so a resume's visibility + focus + reconnect burst is one fetch, not three.
  useEffect(() => subscribeCatchUp(() => { fetchWaitingTasks(); }), [fetchWaitingTasks]);

  // Subscribe to Pusher for real-time updates
  const workspaceIdsKey = workspaceIds.join(',');
  useEffect(() => {
    if (!workspaceIdsKey) return;

    const channelNames = workspaceIds.map(id => `${CHANNEL_PREFIX}workspace-${id}`);
    const events = ['worker:progress', 'worker:completed', 'worker:failed'] as const;

    // Accepts thin events {taskId, status} and legacy {worker:{taskId, status}}.
    // Most of these are runner heartbeats for tasks we don't list — ignored.
    const handlers = events.map(event => [event, (data: unknown) => {
      const action = needsInputEventAction(event, data, prevTaskIdsRef.current);
      if (action.kind === 'refetch') {
        fetchWaitingTasks(true);
      } else if (action.kind === 'remove') {
        setTasks(prev => {
          const filtered = prev.filter(t => t.id !== action.taskId);
          prevTaskIdsRef.current = new Set(filtered.map(t => t.id));
          return filtered;
        });
      }
    }] as const);

    // worker:progress arrives on each workspace's activity channel; bindChannelEvents routes it.
    const releases = channelNames.map((channelName) => bindChannelEvents(channelName, handlers));

    // Channels are shared with the other layout providers, so the cleanup
    // unbinds this provider's handlers explicitly before releasing its holds.
    return () => {
      for (const release of releases) release?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey, fetchWaitingTasks]);

  // Answered here, before the next fetch says so: the banner reads "sent" at once.
  const markAnswerSent = useCallback((taskId: string) => {
    setTasks(prev => prev.map(t => (t.id === taskId ? { ...t, answerSent: true } : t)));
  }, []);

  const count = tasks.filter(t => !t.answerSent).length;

  return (
    <NeedsInputContext.Provider value={{ tasks, count, alertPermission, enableAlerts, markAnswerSent }}>
      {children}
    </NeedsInputContext.Provider>
  );
}

function showToast(task: WaitingTask, router: ReturnType<typeof useRouter>) {
  // Play notification sound
  try {
    const audio = new Audio('/sounds/notification.wav');
    audio.volume = 0.3;
    audio.play().catch(() => {
      // Browser may block autoplay
    });
  } catch {
    // Audio not available
  }

  // Show browser notification if permitted
  if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
    const n = new Notification('A question for you', {
      // The question, one line of context, the recommended default (question brief).
      body: task.waitingFor?.prompt
        ? questionNotificationText({
            prompt: task.waitingFor.prompt,
            options: task.waitingFor.options,
            context: task.waitingFor.context,
            recommended: task.waitingFor.recommended,
            where: { taskTitle: task.title },
          }).message
        : task.title,
      icon: '/favicon.ico',
      tag: `waiting-input-${task.id}`,
    });
    n.onclick = () => { window.focus(); router.push(taskAnswerHref({ taskId: task.id, missionId: task.missionId ?? null })); };
  }
}
