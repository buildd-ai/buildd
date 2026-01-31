'use client';

import PusherClient from 'pusher-js';

// Client-side Pusher instance (optional)
let pusherClient: PusherClient | null = null;

export function getPusherClient(): PusherClient | null {
  if (typeof window === 'undefined') return null;

  if (pusherClient) return pusherClient;

  const key = process.env.NEXT_PUBLIC_PUSHER_KEY;
  const cluster = process.env.NEXT_PUBLIC_PUSHER_CLUSTER;

  if (!key || !cluster) {
    return null; // Pusher not configured
  }

  pusherClient = new PusherClient(key, {
    cluster,
  });

  return pusherClient;
}

/**
 * Subscribe to a channel (no-op if Pusher not configured)
 */
export function subscribeToChannel(channelName: string) {
  const client = getPusherClient();
  if (!client) return null;

  return client.subscribe(channelName);
}

/**
 * Unsubscribe from a channel
 */
export function unsubscribeFromChannel(channelName: string) {
  const client = getPusherClient();
  if (!client) return;

  client.unsubscribe(channelName);
}
