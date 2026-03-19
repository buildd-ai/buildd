'use client';

import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { subscribeToChannel, unsubscribeFromChannel, CHANNEL_PREFIX } from '@/lib/pusher-client';

interface WaitingTask {
  id: string;
  title: string;
  workspaceId: string;
  waitingFor: { type: string; prompt: string; options?: string[] } | null;
}

interface NeedsInputContextValue {
  tasks: WaitingTask[];
  count: number;
}

const NeedsInputContext = createContext<NeedsInputContextValue>({ tasks: [], count: 0 });

export function useNeedsInput() {
  return useContext(NeedsInputContext);
}

interface Props {
  workspaceIds: string[];
  children: React.ReactNode;
}

export function NeedsInputProvider({ workspaceIds, children }: Props) {
  const [tasks, setTasks] = useState<WaitingTask[]>([]);
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

  // Initial fetch + request notification permission
  useEffect(() => {
    fetchWaitingTasks();
    if (typeof Notification !== 'undefined' && Notification.permission === 'default') {
      Notification.requestPermission().catch(() => {});
    }
  }, [fetchWaitingTasks]);

  // Subscribe to Pusher for real-time updates
  const workspaceIdsKey = workspaceIds.join(',');
  useEffect(() => {
    if (!workspaceIdsKey) return;

    const channelNames = workspaceIds.map(id => `${CHANNEL_PREFIX}workspace-${id}`);

    const handleWorkerUpdate = (data: { worker: { taskId: string | null; status: string } }) => {
      const { worker } = data;
      if (!worker.taskId) return;

      if (worker.status === 'waiting_input') {
        // Refetch to get full task details
        fetchWaitingTasks();
      } else {
        // Worker is no longer waiting - remove from list
        setTasks(prev => {
          const filtered = prev.filter(t => t.id !== worker.taskId);
          prevTaskIdsRef.current = new Set(filtered.map(t => t.id));
          return filtered;
        });
      }
    };

    for (const channelName of channelNames) {
      const channel = subscribeToChannel(channelName);
      if (channel) {
        channel.bind('worker:progress', handleWorkerUpdate);
        channel.bind('worker:completed', handleWorkerUpdate);
        channel.bind('worker:failed', handleWorkerUpdate);
      }
    }

    return () => {
      for (const channelName of channelNames) {
        unsubscribeFromChannel(channelName);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceIdsKey, fetchWaitingTasks]);

  return (
    <NeedsInputContext.Provider value={{ tasks, count: tasks.length }}>
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
