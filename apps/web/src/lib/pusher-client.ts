'use client';

import PusherClient from 'pusher-js';
import type { Channel } from 'pusher-js';

/**
 * Client-side Pusher access.
 *
 * Every consumer goes through `subscribeToChannel` / `unsubscribeFromChannel`,
 * which share one connection AND one subscription per channel name. That
 * sharing is not just an optimisation: four independent components subscribe to
 * the same `workspace-<id>` channel for every visible workspace (the escalation,
 * needs-input and connector-reconnect providers in the protected layout, plus
 * HomeAutoRefresh), so a bare `client.unsubscribe()` on one unmount used to
 * silently cut realtime for the other three. See `pusher-client.test.ts`.
 */

/** Opt into the chatty subscription logs in production: localStorage key = '1'. */
const DEBUG_STORAGE_KEY = 'buildd-debug-pusher';

export function shouldLogPusherDebug(
  nodeEnv: string | undefined,
  storageFlag: string | null,
): boolean {
  return nodeEnv !== 'production' || storageFlag === '1';
}

function debugEnabled(): boolean {
  let flag: string | null = null;
  try {
    flag = typeof window !== 'undefined' ? window.localStorage?.getItem(DEBUG_STORAGE_KEY) ?? null : null;
  } catch {
    // Private-mode / blocked storage — fall back to the env check alone.
  }
  return shouldLogPusherDebug(process.env.NODE_ENV, flag);
}

/** Chatty lifecycle logging. Errors below use console.error unconditionally. */
function debug(...args: unknown[]) {
  if (debugEnabled()) console.log(...args);
}

if (typeof window !== 'undefined' && process.env.NODE_ENV === 'development') {
  PusherClient.logToConsole = true;
}

// Client-side Pusher instance (optional)
let pusherClient: PusherClient | null = null;

export function getPusherClient(): PusherClient | null {
  if (typeof window === 'undefined') return null;

  if (pusherClient) return pusherClient;

  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

  if (!key || !cluster) {
    console.warn('[Pusher] Not configured - missing NEXT_PUBLIC_PUSHER_KEY or NEXT_PUBLIC_PUSHER_CLUSTER');
    return null;
  }

  debug('[Pusher] Initializing client with cluster:', cluster);

  pusherClient = new PusherClient(key, {
    cluster,
  });

  // Log connection state changes
  pusherClient.connection.bind('state_change', (states: { previous: string; current: string }) => {
    debug('[Pusher] Connection state:', states.previous, '->', states.current);
  });

  pusherClient.connection.bind('error', (err: Error) => {
    console.error('[Pusher] Connection error:', err);
  });

  return pusherClient;
}

/** One live subscription per channel name, shared by every consumer of it. */
const subscriptions = new Map<string, { channel: Channel; refs: number }>();

/**
 * Subscribe to a channel (no-op if Pusher not configured).
 *
 * Returns the shared channel — callers bind their own events on it and must
 * unbind those in cleanup, then call `unsubscribeFromChannel`.
 */
export function subscribeToChannel(channelName: string): Channel | null {
  const client = getPusherClient();
  if (!client) {
    console.warn('[Pusher] Cannot subscribe - client not initialized');
    return null;
  }

  const existing = subscriptions.get(channelName);
  if (existing) {
    existing.refs++;
    return existing.channel;
  }

  debug('[Pusher] Subscribing to channel:', channelName);
  const channel = client.subscribe(channelName);
  subscriptions.set(channelName, { channel, refs: 1 });

  channel.bind('pusher:subscription_succeeded', () => {
    debug('[Pusher] Subscribed to channel:', channelName);
  });

  channel.bind('pusher:subscription_error', (error: unknown) => {
    console.error('[Pusher] Subscription error for channel:', channelName, error);
  });

  return channel;
}

/**
 * The live channel for `channelName`, or null if nobody holds it. Read-only:
 * unlike `subscribeToChannel` this does NOT take a hold, so it is the safe way
 * to reach a channel you already subscribed to in order to unbind a handler.
 */
export function getSubscribedChannel(channelName: string): Channel | null {
  return subscriptions.get(channelName)?.channel ?? null;
}

/**
 * Release one consumer's hold on a channel. The Pusher subscription is torn
 * down only when the last holder lets go.
 */
export function unsubscribeFromChannel(channelName: string) {
  const entry = subscriptions.get(channelName);
  if (!entry) return;

  entry.refs--;
  if (entry.refs > 0) return;

  subscriptions.delete(channelName);
  debug('[Pusher] Unsubscribing from channel:', channelName);
  getPusherClient()?.unsubscribe(channelName);
}

/** Channel prefix for environment isolation (matches server-side PUSHER_CHANNEL_PREFIX) */
export const CHANNEL_PREFIX = process.env.NEXT_PUBLIC_PUSHER_CHANNEL_PREFIX || '';
