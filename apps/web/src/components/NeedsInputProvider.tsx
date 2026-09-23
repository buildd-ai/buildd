'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, getPusherClient, CHANNEL_PREFIX } from '@/lib/pusher-client';
import { needsInputEventAction, createReconnectDetector } from '@/lib/realtime-throttle';

interface WaitingTask {
  id: string;
  title: string;
  workspaceId: string;
  waitingFor: { type: string; prompt: string; options?: string[] } | null;
}

type AlertPermission = NotificationPermission | 'unsupported';

interface NeedsInputContextValue {
  tasks: WaitingTask[];
  count: number;
  /** Browser notification permission; 'default' means the user hasn't been asked. */
  alertPermission: AlertPermission;
  /** Ask for notification permission. Must run from a user gesture (the 'Enable alerts' control). */
  enableAlerts: () => void;
}

const NeedsInputContext = createContext<NeedsInputContextValue>({
  tasks: [],
  count: 0,
  alertPermission: 'unsupported',
  enableAlerts: () => {},
});

export function useNeedsInput() {
  return useContext(NeedsInputContext);
}

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

  // Fetch waiting-input tasks
  const fetchWaitingTasks = useCallback(async () => {
    try {
      const res = await fetch('/api/tasks/waiting-input');
      if (res.ok) {
        const data = await res.json();
        const newTasks: WaitingTask[] = data.tasks || [];
        setTasks(newTasks);

        // Show toast for newly added tasks (not on initial load)
        if (initialFetchDone.current) {
          const prevIds = prevTaskIdsRef.current;
          for (const task of newTasks) {
            if (!prevIds.has(task.id)) {
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

  // Backstop for events missed while the tab was hidden or the socket was down.
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') fetchWaitingTasks();
    };
    document.addEventListener('visibilitychange', onVisible);

    const connection = getPusherClient()?.connection;
    const isReconnect = createReconnectDetector();
    const onStateChange = (states: { previous: string; current: string }) => {
      if (isReconnect(states)) fetchWaitingTasks();
    };
    connection?.bind('state_change', onStateChange);

    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      connection?.unbind('state_change', onStateChange);
    };
  }, [fetchWaitingTasks]);

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
        fetchWaitingTasks();
      } else if (action.kind === 'remove') {
        setTasks(prev => {
          const filtered = prev.filter(t => t.id !== action.taskId);
          prevTaskIdsRef.current = new Set(filtered.map(t => t.id));
          return filtered;
        });
      }
    }] as const);

    const bound = channelNames.map((channelName) => {
      const channel = subscribeToChannel(channelName);
      for (const [event, handler] of handlers) channel?.bind(event, handler);
      return { channelName, channel };
    });

    // Channels are shared with the other layout providers, so this handler must
    // be unbound explicitly — releasing the subscription no longer drops it.
    return () => {
      for (const { channelName, channel } of bound) {
        for (const [event, handler] of handlers) channel?.unbind(event, handler);
        unsubscribeFromChannel(channelName);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey, fetchWaitingTasks]);

  return (
    <NeedsInputContext.Provider value={{ tasks, count: tasks.length, alertPermission, enableAlerts }}>
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
    const n = new Notification('Task needs your input', {
      body: task.waitingFor?.prompt || task.title,
      icon: '/favicon.ico',
      tag: `waiting-input-${task.id}`,
    });
    n.onclick = () => { window.focus(); router.push(`/app/tasks/${task.id}`); };
  }
}
