/**
 * The slice of the `pusher` server SDK apps/web uses (the constructor and
 * `trigger`), over fetch. The SDK goes through node-fetch / http, which the
 * Workers runtime does not run, and lib/pusher.ts catches the failure, so
 * realtime updates would drop silently. Same REST call, same signing:
 * POST /apps/{id}/events with body_md5 and an HMAC-SHA256 auth_signature
 * (https://pusher.com/docs/channels/library_auth_reference/rest-api/).
 */
import { createHash, createHmac } from 'node:crypto';

export interface PusherOptions {
  appId: string; key: string; secret: string; cluster?: string;
  useTLS?: boolean; host?: string; port?: string | number;
}

export function signedEventsUrl(o: PusherOptions, body: string, timestamp: number): string {
  const path = `/apps/${o.appId}/events`;
  const params: Record<string, string> = {
    auth_key: o.key,
    auth_timestamp: String(timestamp),
    auth_version: '1.0',
    body_md5: createHash('md5').update(body, 'utf8').digest('hex'),
  };
  const query = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join('&');
  const signature = createHmac('sha256', o.secret).update(`POST\n${path}\n${query}`, 'utf8').digest('hex');
  const scheme = o.useTLS === false ? 'http' : 'https';
  const host = o.host ? `${o.host}${o.port ? `:${o.port}` : ''}` : `api-${o.cluster ?? 'mt1'}.pusher.com`;
  return `${scheme}://${host}${path}?${query}&auth_signature=${signature}`;
}

export class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: string) { super(message); }
}

export default class Pusher {
  constructor(private readonly options: PusherOptions) {}

  async trigger(channel: string | string[], event: string, data: unknown): Promise<Response> {
    const channels = Array.isArray(channel) ? channel : [channel];
    const body = JSON.stringify({ name: event, channels, data: typeof data === 'string' ? data : JSON.stringify(data) });
    const res = await fetch(signedEventsUrl(this.options, body, Math.floor(Date.now() / 1000)), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new RequestError(`Unexpected status code ${res.status}`, res.status, text);
    }
    return res;
  }
}
