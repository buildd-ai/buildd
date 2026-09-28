/**
 * `GET` / `PATCH` handlers for the per-person tool-permission preference,
 * matching buildd's `/api/chat/permissions` contract
 * (`GetToolPermissionsResponse`, `UpdateToolPermissionRequest`).
 *
 * The app authenticates and passes the user id; storage is the app's
 * (`PermissionPrefs`: the list of group keys the person set to Allow).
 */

import type { GetToolPermissionsResponse, UpdateToolPermissionRequest } from '@builddai/ai-kit/chat/contract';
import type { ToolGroups } from './permissions';

export interface PermissionPrefs {
  /** The stored list of allowed group keys (any shape; it is re-parsed). */
  get(userId: string): Promise<unknown> | unknown;
  set(userId: string, allowedGroups: string[]): Promise<void> | void;
}

export interface PermissionsApi {
  /** The person's allowed groups, parsed against the declaration. Use it as `createChatTurn({ permissions })`. */
  allowed(userId: string): Promise<ReadonlySet<string>>;
  GET(ctx: { userId: string }): Promise<Response>;
  /** Body: `{ group, mode: 'ask' | 'allow' }`. 400 for a locked or unknown group. */
  PATCH(req: Request, ctx: { userId: string }): Promise<Response>;
}

export function createPermissionsApi<G extends string>(groups: ToolGroups<G>, prefs: PermissionPrefs): PermissionsApi {
  const allowed = async (userId: string) => groups.parseAllowed(await prefs.get(userId));
  const rows = async (userId: string): Promise<GetToolPermissionsResponse> => ({ rows: groups.rows(await allowed(userId)) });
  return {
    allowed,
    async GET({ userId }) {
      return Response.json(await rows(userId));
    },
    async PATCH(req, { userId }) {
      let body: Partial<UpdateToolPermissionRequest>;
      try { body = await req.json() as Partial<UpdateToolPermissionRequest>; } catch { return Response.json({ error: 'invalid JSON body' }, { status: 400 }); }
      const group = body?.group;
      if (typeof group !== 'string' || !(groups.allowable as readonly string[]).includes(group)) {
        return Response.json({ error: 'group must be a group that can be set to Allow' }, { status: 400 });
      }
      if (body.mode !== 'ask' && body.mode !== 'allow') return Response.json({ error: "mode must be 'ask' or 'allow'" }, { status: 400 });
      const next = new Set<string>(await allowed(userId));
      if (body.mode === 'allow') next.add(group); else next.delete(group);
      await prefs.set(userId, [...next].sort());
      return Response.json(await rows(userId));
    },
  };
}
