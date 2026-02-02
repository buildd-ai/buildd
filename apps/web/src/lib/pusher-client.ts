'use client';

import PusherClient from 'pusher-js';

// Enable Pusher debug logging in development
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

  console.log('[Pusher] Initializing client with cluster:', cluster);

  pusherClient = new PusherClient(key, {
    cluster,
  });

  // Log connection state changes
  pusherClient.connection.bind('state_change', (states: { previous: string; current: string }) => {
    console.log('[Pusher] Connection state:', states.previous, '->', states.current);
  });

  pusherClient.connection.bind('error', (err: Error) => {
    console.error('[Pusher] Connection error:', err);
  });

  return pusherClient;
}

/**
 * Subscribe to a channel (no-op if Pusher not configured)
 */
export function subscribeToChannel(channelName: string) {
  const client = getPusherClient();
  if (!client) {
    console.warn('[Pusher] Cannot subscribe - client not initialized');
    return null;
  }

  console.log('[Pusher] Subscribing to channel:', channelName);
  const channel = client.subscribe(channelName);

  channel.bind('pusher:subscription_succeeded', () => {
    console.log('[Pusher] Subscribed to channel:', channelName);
  });

  channel.bind('pusher:subscription_error', (error: unknown) => {
    console.error('[Pusher] Subscription error for channel:', channelName, error);
  });

  return channel;
}

/**
 * Unsubscribe from a channel
 */
export function unsubscribeFromChannel(channelName: string) {
  const client = getPusherClient();
  if (!client) return;

  client.unsubscribe(channelName);
}
