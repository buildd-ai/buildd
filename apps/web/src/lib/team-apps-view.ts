// @ui-copy: strings here render in the app; copy:check and the em-dash test scan them.
/**
 * Settings › Team › Apps › Team apps: one row per app the team's agents
 * can call. A catalog entry and the team's installed connector on the same
 * host are one app; an installed connector no catalog entry covers (a custom
 * URL) is an app of its own. Client-safe and pure: the state comes from the
 * API, and a label never says more than the backend did ("Connected" only for
 * a live credential).
 *
 * Words a customer reads only: no vendor review status, no "coming soon".
 */
import { connectorHostKey, type CatalogPolicy, type CustomerCatalogEntry } from './connector-catalog';

/** A team connector as GET /api/connectors returns it. */
export interface TeamConnector {
  id: string;
  name: string;
  url: string;
  authMode: 'none' | 'header' | 'oauth';
  status: 'connected' | 'expired' | 'not_connected';
  /** Shared to this team by another team, which holds the credential. */
  shared?: boolean;
  ownerTeamName?: string | null;
  iconUrl?: string | null;
  blockedByPolicy?: boolean;
}

export interface TeamApp {
  /** Stable row key: the catalog slug, else `connector:<id>`. */
  key: string;
  name: string;
  description: string | null;
  iconUrl: string | null;
  url: string;
  /** The catalog entry, when one covers this app. */
  entry: CustomerCatalogEntry | null;
  /** The connector this team can use for it, when installed or shared in. */
  connector: TeamConnector | null;
}

export type TeamAppActionKind = 'install' | 'connect' | 'set_key' | 'request';

export interface TeamAppState {
  /** What is true now, in the reader's words. */
  label: string;
  /** `ok` live, `act` needs a person, `muted` nothing to do here. */
  tone: 'ok' | 'act' | 'muted';
  /** The row's one next step for this reader, or null. */
  action: { kind: TeamAppActionKind; label: string } | null;
}

/**
 * Catalog entries in catalog order, then connectors no entry covers. An
 * unavailable entry the team has no connector for goes last.
 */
export function buildTeamApps(entries: readonly CustomerCatalogEntry[], connectors: readonly TeamConnector[]): TeamApp[] {
  const used = new Set<string>();
  const forHost = (url: string) => {
    const host = connectorHostKey(url);
    const pick = connectors.find(c => !c.shared && connectorHostKey(c.url) === host) ?? connectors.find(c => connectorHostKey(c.url) === host) ?? null;
    if (pick) for (const c of connectors) if (connectorHostKey(c.url) === host) used.add(c.id);
    return pick;
  };
  const fromCatalog = entries.map((e): TeamApp => ({
    key: e.slug,
    name: e.name,
    description: e.description || null,
    iconUrl: e.iconUrl || null,
    url: e.url,
    entry: e,
    connector: forHost(e.url),
  }));
  const custom = connectors.filter(c => !used.has(c.id)).map((c): TeamApp => ({
    key: `connector:${c.id}`,
    name: c.name,
    description: null,
    iconUrl: c.iconUrl ?? null,
    url: c.url,
    entry: null,
    connector: c,
  }));
  const offered = (a: TeamApp) => !(a.entry?.unavailable && !a.connector);
  return [...fromCatalog.filter(offered), ...custom, ...fromCatalog.filter(a => !offered(a))];
}

export function isBlocked(app: TeamApp): boolean {
  return app.entry?.policy === 'blocked' || !!app.connector?.blockedByPolicy;
}

/**
 * The row's state and its one action. Admins (`canManage`) get the step that
 * moves the app on; members ask for an app the team has not set up and
 * otherwise read. An app another team shares in is that team's to connect.
 */
export function teamAppState(app: TeamApp, canManage: boolean): TeamAppState {
  const c = app.connector;
  if (isBlocked(app)) return { label: 'Blocked by your team', tone: 'muted', action: null };
  if (c?.authMode === 'none' || c?.status === 'connected') return { label: 'Connected', tone: 'ok', action: null };
  if (app.entry?.unavailable) return { label: 'Not available', tone: 'muted', action: null };
  const own = canManage && !!c && !c.shared;
  if (!c) {
    if (canManage) return { label: 'Not set up', tone: 'muted', action: { kind: 'install', label: app.entry?.authMode === 'none' ? 'Add' : 'Connect' } };
    return { label: 'Not set up', tone: 'muted', action: { kind: 'request', label: 'Request' } };
  }
  if (c.status === 'expired') return { label: 'Sign-in expired', tone: 'act', action: own ? { kind: 'connect', label: 'Reconnect' } : null };
  if (c.authMode === 'header') return { label: 'Needs a key', tone: 'act', action: own ? { kind: 'set_key', label: 'Add key' } : null };
  return { label: 'Not connected', tone: 'act', action: own ? { kind: 'connect', label: 'Connect' } : null };
}

/** The policy an admin picks in an app's details, in the reader's words. */
export const POLICY_CHOICES: { value: CatalogPolicy; label: string }[] = [
  { value: 'available', label: 'Available to add' },
  { value: 'preinstalled', label: 'In every workspace' },
  { value: 'blocked', label: 'Blocked' },
];

/** "All workspaces", "2 of 5 workspaces", "No workspaces". */
export function workspaceSummary(enabled: number, total: number): string {
  if (total === 0 || enabled === 0) return 'No workspaces';
  if (enabled >= total) return 'All workspaces';
  return `${enabled} of ${total} workspaces`;
}

/**
 * A failed connect or install as one line for the person who clicked. Only a
 * server `message` (written for people) is shown; a bare error code or a
 * developer string reads as a plain retry.
 */
export function stepErrorText(name: string, body: { message?: unknown }): string {
  return typeof body.message === 'string' && body.message.trim() ? body.message : `Couldn't connect ${name}. Try again.`;
}
