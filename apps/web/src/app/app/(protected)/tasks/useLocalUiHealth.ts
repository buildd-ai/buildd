'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface HeartbeatData {
  localUiUrl: string;
  viewerToken?: string;
  accountId: string;
  accountName: string;
  maxConcurrent: number;
  activeWorkers: number;
  capacity: number;
  workspaceIds: string[];
  workspaceNames: string[];
}

interface HealthResponse {
  alive: boolean;
  activeWorkers: number;
  maxConcurrent: number;
  capacity: number;
}

export type LocalUiStatus = 'checking' | 'online' | 'unreachable';

export interface LocalUiInfo {
  localUiUrl: string;
  accountId: string;
  accountName: string;
  maxConcurrent: number;
  activeWorkers: number;
  capacity: number;
  workspaceIds: string[];
  workspaceNames: string[];
  status: LocalUiStatus;
  live: boolean; // true = data from direct ping, false = heartbeat fallback
}

interface UseLocalUiHealthResult {
  localUis: LocalUiInfo[];
  available: LocalUiInfo[]; // filtered to capacity > 0
  loading: boolean;
  refresh: () => void;
}

/**
 * Hook that fetches active local-ui workers and tries to ping them directly
 * for real-time capacity data. Falls back to heartbeat data gracefully.
 */
export function useLocalUiHealth(workspaceId: string): UseLocalUiHealthResult {
  const [localUis, setLocalUis] = useState<LocalUiInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  const fetchAndPing = useCallback(async () => {
    // Cancel any in-flight requests
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);

    try {
      // Step 1: Get heartbeat data from server
      const res = await fetch('/api/workers/active', { signal: controller.signal });
      if (!res.ok) {
        setLocalUis([]);
        return;
      }

      const data = await res.json();
      const heartbeats: HeartbeatData[] = (data.activeLocalUis || []).filter(
        (ui: HeartbeatData) => ui.workspaceIds.includes(workspaceId)
      );

      if (heartbeats.length === 0) {
        setLocalUis([]);
        return;
      }

      // Step 2: Set initial state from heartbeat data (status: checking)
      const initial: LocalUiInfo[] = heartbeats.map(hb => ({
        localUiUrl: hb.localUiUrl,
        accountId: hb.accountId,
        accountName: hb.accountName,
        maxConcurrent: hb.maxConcurrent,
        activeWorkers: hb.activeWorkers,
        capacity: hb.capacity,
        workspaceIds: hb.workspaceIds,
        workspaceNames: hb.workspaceNames,
        status: 'checking' as LocalUiStatus,
        live: false,
      }));
      setLocalUis(initial);

      // Step 3: Try to ping each local-ui directly (in parallel)
      const results = await Promise.allSettled(
        heartbeats.map(async (hb): Promise<{ url: string; health: HealthResponse | null }> => {
          // Skip if dashboard is HTTPS and local-ui is HTTP (mixed-content blocked)
          if (typeof window !== 'undefined' && window.location.protocol === 'https:' && hb.localUiUrl.startsWith('http://')) {
            return { url: hb.localUiUrl, health: null };
          }

          try {
            const healthUrl = new URL('/health', hb.localUiUrl);
            if (hb.viewerToken) {
              healthUrl.searchParams.set('token', hb.viewerToken);
            }
            const pingRes = await fetch(healthUrl.toString(), {
              signal: AbortSignal.timeout(3000),
              mode: 'cors',
            });
            if (pingRes.ok) {
              const health: HealthResponse = await pingRes.json();
              return { url: hb.localUiUrl, health };
            }
          } catch {
            // Unreachable — fall through
          }
          return { url: hb.localUiUrl, health: null };
        })
      );

      if (controller.signal.aborted) return;

      // Step 4: Merge ping results with heartbeat data
      const healthMap = new Map<string, HealthResponse | null>();
      for (const r of results) {
        if (r.status === 'fulfilled') {
          healthMap.set(r.value.url, r.value.health);
        }
      }

      const merged: LocalUiInfo[] = heartbeats.map(hb => {
        const health = healthMap.get(hb.localUiUrl);
        if (health) {
          return {
            localUiUrl: hb.localUiUrl,
            accountId: hb.accountId,
            accountName: hb.accountName,
            maxConcurrent: health.maxConcurrent,
            activeWorkers: health.activeWorkers,
            capacity: health.capacity,
            workspaceIds: hb.workspaceIds,
            workspaceNames: hb.workspaceNames,
            status: 'online' as LocalUiStatus,
            live: true,
          };
        }
        return {
          localUiUrl: hb.localUiUrl,
          accountId: hb.accountId,
          accountName: hb.accountName,
          maxConcurrent: hb.maxConcurrent,
          activeWorkers: hb.activeWorkers,
          capacity: hb.capacity,
          workspaceIds: hb.workspaceIds,
          workspaceNames: hb.workspaceNames,
          status: 'unreachable' as LocalUiStatus,
          live: false,
        };
      });

      setLocalUis(merged);
    } catch (err) {
      if (controller.signal.aborted) return;
      setLocalUis([]);
    } finally {
      if (!controller.signal.aborted) {
        setLoading(false);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    fetchAndPing();
    return () => {
      abortRef.current?.abort();
    };
  }, [fetchAndPing]);

  const available = localUis.filter(ui => ui.capacity > 0);

  return { localUis, available, loading, refresh: fetchAndPing };
}
