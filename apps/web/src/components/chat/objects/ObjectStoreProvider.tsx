'use client';

/**
 * The feed's object registry context: one `ObjectStore` per chat surface.
 * The app's default source reads `GET /api/objects/[kind]/[id]` and listens on
 * the object's existing Pusher channels; the dev fixtures page passes a memory
 * source instead.
 */
import { createContext, useCallback, useContext, useMemo, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { CHANNEL_PREFIX, subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import { MISSION_EVENTS, WORKSPACE_EVENTS } from '@/app/app/(protected)/missions/[id]/MissionAutoRefresh';
import { refKey, type BuilddObjectRef } from '../chat-contract';
import { createObjectStore, type ObjectEntry, type ObjectSource, type ObjectStore } from './object-store';
import type { ObjectView } from './object-views';

/** The object's own channels: its workspace always, plus the mission channel for a mission. */
export function objectChannels(ref: BuilddObjectRef, view: ObjectView | null): Array<{ name: string; events: readonly string[] }> {
  const out: Array<{ name: string; events: readonly string[] }> = [];
  const ws = ref.workspaceId ?? view?.workspaceId ?? null;
  if (ws) out.push({ name: `${CHANNEL_PREFIX}workspace-${ws}`, events: WORKSPACE_EVENTS });
  const missionId = ref.kind === 'mission' ? ref.id : (view && 'missionId' in view ? view.missionId : null) ?? (ref.kind === 'question' ? ref.missionId ?? null : null);
  if (missionId) out.push({ name: `${CHANNEL_PREFIX}mission-${missionId}`, events: MISSION_EVENTS });
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Where a ref's live view is read. A question ref names its waiting worker and
 * carries the task (the respond route's id); a PR ref is `owner/repo#n`, read
 * through its task when the ref names one.
 */
export function objectUrl(ref: BuilddObjectRef): string {
  const base = '/api/objects';
  if (ref.kind === 'question') return `${base}/question/${encodeURIComponent(ref.taskId ?? ref.id)}`;
  if (ref.kind === 'pr') {
    if (ref.taskId) return `${base}/pr/${encodeURIComponent(ref.taskId)}`;
    if (!UUID_RE.test(ref.id)) return `${base}/pr/ref?ref=${encodeURIComponent(ref.id)}`;
  }
  return `${base}/${ref.kind}/${encodeURIComponent(ref.id)}`;
}

export const httpObjectSource: ObjectSource = {
  async load(ref) {
    const res = await fetch(objectUrl(ref), { credentials: 'include', cache: 'no-store' });
    if (!res.ok) throw new Error(res.status === 404 ? 'Not found' : `Could not load (${res.status})`);
    return (await res.json()) as ObjectView;
  },
  watch(ref, view, emit) {
    const subs = objectChannels(ref, view);
    const bound: Array<[ReturnType<typeof subscribeToChannel>, string, (d: unknown) => void, string]> = [];
    for (const { name, events } of subs) {
      const ch = subscribeToChannel(name);
      for (const event of events) {
        const fn = (d: unknown) => emit(event, d);
        ch?.bind(event, fn);
        bound.push([ch, event, fn, name]);
      }
    }
    return () => {
      for (const [ch, event, fn] of bound) ch?.unbind(event, fn);
      for (const { name } of subs) unsubscribeFromChannel(name);
    };
  },
};

const ObjectStoreContext = createContext<ObjectStore | null>(null);

export function ObjectStoreProvider({ source, store: given, children }: { source?: ObjectSource; store?: ObjectStore; children: ReactNode }) {
  const store = useMemo(() => given ?? createObjectStore(source ?? httpObjectSource), [given, source]);
  return <ObjectStoreContext.Provider value={store}>{children}</ObjectStoreContext.Provider>;
}

export function useObjectStore(): ObjectStore {
  const store = useContext(ObjectStoreContext);
  if (!store) throw new Error('useObjectStore outside ObjectStoreProvider');
  return store;
}

const SERVER_ENTRY: ObjectEntry = { view: null, error: null, loading: true };

/** The live entry for one ref; subscribes while mounted. */
export function useObjectEntry(ref: BuilddObjectRef): ObjectEntry {
  const store = useObjectStore();
  const key = refKey(ref);
  const latest = useRef(ref);
  latest.current = ref;
  // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on the ref's identity, not the object
  const subscribe = useCallback((l: () => void) => store.subscribe(latest.current, l), [store, key]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const get = useCallback(() => store.get(latest.current), [store, key]);
  return useSyncExternalStore(subscribe, get, () => SERVER_ENTRY);
}
