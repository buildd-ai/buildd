import { useEffect, useState, useCallback, useRef } from 'react';
import type { SSEEvent } from '@buildd/shared';

export function useSSE(url: string) {
  const [events, setEvents] = useState<SSEEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource(url);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        setEvents((prev) => [...prev.slice(-100), JSON.parse(e.data)]);
      } catch {}
    };

    return () => es.close();
  }, [url]);

  const clear = useCallback(() => setEvents([]), []);

  return { events, connected, clear };
}

export function useWorkerSSE(workerId: string) {
  return useSSE(`/api/workers/${workerId}/events`);
}

export function useWorkspaceSSE(workspaceId: string) {
  return useSSE(`/api/events?workspaceId=${workspaceId}`);
}
