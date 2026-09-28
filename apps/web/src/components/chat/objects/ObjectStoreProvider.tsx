'use client';

/**
 * The feed's object registry context: one `ObjectStore` per chat surface,
 * through the kit's `ObjectStoreProvider` / `useObjectEntry`. buildd's
 * default source reads `GET /api/objects/[kind]/[id]` and listens on
 * the object's existing Pusher channels; the dev fixtures page passes a memory
 * source instead.
 */
import { useMemo, type ReactNode } from 'react';
import {
  ObjectStoreProvider as KitObjectStoreProvider,
  useObjectEntry as useKitObjectEntry,
  useObjectStore as useKitObjectStore,
  type ObjectStore as KitObjectStore,
} from '@builddai/ai-kit/chat/react';
import { CHANNEL_PREFIX, subscribeToChannel, unsubscribeFromChannel } from '@/lib/pusher-client';
import { MISSION_EVENTS, WORKSPACE_EVENTS } from '@/app/app/(protected)/missions/[id]/MissionAutoRefresh';
import type { BuilddObjectRef } from '../chat-contract';
import { MISSION_OBJECT_EXTRA_EVENTS, createObjectStore, type ObjectEntry, type ObjectSidecar, type ObjectSource, type ObjectStore } from './object-store';
import type { ObjectView } from './object-views';

type KitStore = KitObjectStore<BuilddObjectRef, ObjectView, unknown>;

/** The object's own channels: its workspace always, plus the mission channel for a mission. */
export function objectChannels(ref: BuilddObjectRef, view: ObjectView | null): Array<{ name: string; events: readonly string[] }> {
  const out: Array<{ name: string; events: readonly string[] }> = [];
  const ws = ref.workspaceId ?? view?.workspaceId ?? null;
  if (ws) out.push({ name: `${CHANNEL_PREFIX}workspace-${ws}`, events: WORKSPACE_EVENTS });
  const missionId = ref.kind === 'mission' ? ref.id : (view && 'missionId' in view ? view.missionId : null) ?? (ref.kind === 'question' ? ref.missionId ?? null : null);
  if (missionId) out.push({ name: `${CHANNEL_PREFIX}mission-${missionId}`, events: [...new Set<string>([...MISSION_EVENTS, ...MISSION_OBJECT_EXTRA_EVENTS])] });
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

/** One store per chat surface: the kit's context over buildd's store (object-store.ts). */
export function ObjectStoreProvider({ source, store: given, children }: { source?: ObjectSource; store?: ObjectStore; children: ReactNode }) {
  const store = useMemo(() => given ?? createObjectStore(source ?? httpObjectSource), [given, source]);
  return <KitObjectStoreProvider store={store as KitStore}>{children}</KitObjectStoreProvider>;
}

export function useObjectStore(): ObjectStore {
  return useKitObjectStore<BuilddObjectRef, ObjectView, ObjectSidecar>() as ObjectStore;
}

/** The live entry for one ref; subscribes while mounted (keyed on `kind:id`). */
export function useObjectEntry(ref: BuilddObjectRef): ObjectEntry {
  return useKitObjectEntry<ObjectView, BuilddObjectRef>(ref);
}
