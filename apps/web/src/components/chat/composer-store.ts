'use client';

/**
 * The new-chat composer's state, shared by the Home card, /app/chat and the
 * canvas: the unsent draft, the workspace and the tier. One module-level store,
 * so it survives client navigation between them.
 *
 * Seeded once per team from `GET /api/chat/composer` (the person's last choices,
 * the tier capped by the team's policy: lib/chat/composer-prefs.ts). A workspace
 * or tier change is written back with `PATCH /api/chat/composer`, so the next
 * new chat on any device starts there. A field the person already changed is
 * never overwritten by a seed that lands late.
 */
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import type { ChatTierName, GetComposerPrefsResponse, UpdateComposerPrefsRequest } from '@buildd/shared';

export interface ComposerState {
  teamId: string | null;
  draft: string;
  /** Null = all workspaces. */
  workspaceId: string | null;
  /** Null = auto. */
  tier: ChatTierName | null;
  seeded: boolean;
  /** Fields the person set before the seed arrived. */
  touched: { workspaceId: boolean; tier: boolean };
}

const EMPTY: ComposerState = { teamId: null, draft: '', workspaceId: null, tier: null, seeded: false, touched: { workspaceId: false, tier: false } };

let state: ComposerState = EMPTY;
const listeners = new Set<() => void>();
let seeding: { teamId: string; promise: Promise<void> } | null = null;

function set(next: ComposerState) {
  state = next;
  for (const l of listeners) l();
}

export function getComposerState(): ComposerState {
  return state;
}

/** Tests only. */
export function resetComposerStore() {
  state = EMPTY;
  seeding = null;
}

/** A new team starts empty: a draft or workspace never crosses teams. */
function forTeam(teamId: string): ComposerState {
  return state.teamId === teamId ? state : { ...EMPTY, teamId };
}

/** Pure: a seed never overwrites what the person already chose. */
export function applySeed(s: ComposerState, seed: GetComposerPrefsResponse): ComposerState {
  return {
    ...s,
    seeded: true,
    workspaceId: s.touched.workspaceId || seed.workspaceId === undefined ? s.workspaceId : seed.workspaceId,
    tier: s.touched.tier ? s.tier : seed.tier,
  };
}

export function seedComposerStore(teamId: string): Promise<void> {
  if (state.teamId === teamId && state.seeded) return Promise.resolve();
  if (seeding?.teamId === teamId) return seeding.promise;
  set(forTeam(teamId));
  const promise = fetch(`/api/chat/composer?teamId=${encodeURIComponent(teamId)}`, { credentials: 'include', cache: 'no-store' })
    .then(r => (r.ok ? r.json() as Promise<GetComposerPrefsResponse> : null))
    .catch(() => null)
    .then(seed => {
      if (state.teamId !== teamId) return;
      set(seed ? applySeed(state, seed) : { ...state, seeded: true });
    })
    .finally(() => { if (seeding?.teamId === teamId) seeding = null; });
  seeding = { teamId, promise };
  return promise;
}

export function setComposerDraft(teamId: string, draft: string) {
  set({ ...forTeam(teamId), draft });
}

function remember(body: UpdateComposerPrefsRequest) {
  void fetch('/api/chat/composer', {
    method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch(() => {});
}

/** The person picked a workspace (any composer, new chat or not): use it and remember it. */
export function chooseComposerWorkspace(teamId: string, workspaceId: string | null) {
  const s = forTeam(teamId);
  set({ ...s, workspaceId, touched: { ...s.touched, workspaceId: true } });
  remember({ teamId, workspaceId });
}

/** The person picked a tier (any composer, new chat or not): use it and remember it. */
export function chooseComposerTier(teamId: string, tier: ChatTierName | null) {
  const s = forTeam(teamId);
  set({ ...s, tier, touched: { ...s.touched, tier: true } });
  remember({ teamId, tier });
}

function subscribe(fn: () => void) {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

const serverSnapshot = () => EMPTY;

/**
 * The shared new-chat composer for this team. `scopeWorkspaceId` is the page's
 * own scope (an object's workspace, `?ws=`): it wins until the person picks
 * another. A remembered workspace that isn't in `workspaces` reads as all.
 */
export function useSharedComposer(teamId: string, workspaces: readonly { id: string }[], scopeWorkspaceId: string | null = null) {
  const snap = useSyncExternalStore(subscribe, getComposerState, serverSnapshot);
  const [scoped, setScoped] = useState(scopeWorkspaceId);
  useEffect(() => { void seedComposerStore(teamId); }, [teamId]);
  const mine = snap.teamId === teamId ? snap : { ...EMPTY, teamId };
  const picked = scoped ?? mine.workspaceId;
  const workspaceId = picked && workspaces.some(w => w.id === picked) ? picked : null;
  return {
    draft: mine.draft,
    workspaceId,
    tier: mine.tier,
    seeded: mine.seeded,
    setDraft: useCallback((d: string) => setComposerDraft(teamId, d), [teamId]),
    setWorkspaceId: useCallback((w: string | null) => { setScoped(null); chooseComposerWorkspace(teamId, w); }, [teamId]),
    setTier: useCallback((t: ChatTierName | null) => chooseComposerTier(teamId, t), [teamId]),
  };
}
