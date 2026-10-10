/**
 * Settings information architecture: one source of truth for the settings
 * sub-nav (desktop), the settings index list (mobile), the mobile header's
 * title and back link, and the redirects that keep old `/app/settings#anchor`
 * links working.
 *
 * Every item is its own route so a section is linkable. Groups are labels
 * only; they have no page of their own. A group is one scope: your own
 * settings, or the team's. One page holds both: Connected apps lists the apps
 * you signed in and the team's MCP connectors, since both are outside tools;
 * its team half follows manage_connectors.
 */

import type { Permission } from './permission-registry';

export type SettingsSectionId =
  | 'account'
  | 'keys'
  | 'notifications'
  | 'connections'
  | 'team'
  | 'roles'
  | 'billing'
  | 'models'
  | 'workspaces'
  | 'runners'
  | 'alerts'
  | 'integrations';

export interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  href: string;
  /** One line under the label on the settings index. */
  description: string;
  /** Other path prefixes that belong to this section (detail pages). */
  alsoMatches?: string[];
  /**
   * Team sections: the permissions behind the page's controls. Holding none of
   * them, the viewer sees the page read-only (settingsReadOnly). Your own
   * sections have none: everything on them is yours to change.
   */
  manage?: readonly Permission[];
}

/** Whose settings a group holds: the signed-in person's, or the team's. */
export type SettingsScope = 'you' | 'team';

export interface SettingsNavGroup {
  label: string;
  scope: SettingsScope;
  items: SettingsNavItem[];
}

export const SETTINGS_INDEX_HREF = '/app/settings';

/** The one line a team page shows to someone who can't change it. */
export const TEAM_MANAGED_LINE = 'Managed by your team admins.';

/**
 * Two groups, by whose setting it is. You: what only you see and change.
 * Team: what everyone on the team shares; members see it read-only.
 */
export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'You',
    scope: 'you',
    items: [
      {
        id: 'account',
        label: 'Profile',
        href: '/app/settings/account',
        description: 'Your sign-in, preferences, teams and standing rules for chat.',
      },
      {
        id: 'keys',
        label: 'Keys',
        href: '/app/settings/keys',
        description: 'Your own model keys, used when the team lets personal keys pay.',
      },
      {
        id: 'notifications',
        label: 'Notifications',
        href: '/app/settings/notifications',
        description: 'Your Pushover key, for alerts on work you watch.',
      },
      {
        id: 'connections',
        label: 'Connected apps',
        href: '/app/settings/connections',
        description: 'Apps signed in to buildd as you, and the outside tools your agents can call.',
      },
    ],
  },
  {
    label: 'Team',
    scope: 'team',
    items: [
      {
        id: 'team',
        label: 'Members',
        href: '/app/settings/team',
        description: 'Who is on the team, what each person can change, and the team timezone.',
        manage: ['manage_team_members', 'assign_team_roles', 'assign_team_owner', 'manage_team_settings', 'manage_team_permissions', 'delete_team'],
      },
      {
        id: 'roles',
        label: 'Roles',
        href: '/app/settings/roles',
        description: 'The agents on the team: what each one does, its model and its tools.',
        manage: ['manage_agent_roles'],
      },
      {
        id: 'billing',
        label: 'Billing and budgets',
        href: '/app/settings/billing',
        description: 'The plan and seats, what you and the team spend, and daily caps.',
        manage: ['manage_billing', 'manage_team_settings'],
      },
      {
        id: 'models',
        label: 'Models',
        href: '/app/settings/models',
        description: 'Team and workspace keys, which model backs each tier, and AI features.',
        manage: ['manage_inference_providers', 'manage_team_credentials', 'manage_team_model_keys', 'manage_model_tiers', 'manage_team_settings', 'manage_chat_retro'],
      },
      {
        id: 'workspaces',
        label: 'Workspaces',
        href: '/app/settings/workspaces',
        description: 'Each repo agents work in: delivery, merge policy and where its work runs.',
        alsoMatches: ['/app/settings/workspace/'],
        manage: ['create_workspace', 'manage_workspace_settings'],
      },
      {
        id: 'runners',
        label: 'Runners',
        href: '/app/settings/runners',
        description: 'Runner tokens, the cloud runner and Cloudflare.',
        manage: ['manage_team_keys', 'manage_team_model_keys'],
      },
      {
        id: 'alerts',
        label: 'Alerts',
        href: '/app/settings/team-notifications',
        description: "Where the team's alerts go: Pushover or a webhook, and which events.",
        manage: ['manage_team_notifications'],
      },
      {
        id: 'integrations',
        label: 'Integrations',
        href: '/app/settings/integrations',
        description: 'GitHub, Vercel, and the bucket where run evidence is kept.',
        manage: ['manage_github_installation', 'manage_team_credentials', 'manage_evidence_backends'],
      },
    ],
  },
];

export const SETTINGS_ITEMS: SettingsNavItem[] = SETTINGS_NAV.flatMap((g) => g.items);

/** The billing section while BILLING_ENFORCED is off: the same page, budgets only. */
const BUDGETS_ONLY: Pick<SettingsNavItem, 'label' | 'description'> = {
  label: 'Budgets',
  description: 'What you and the team spend, and daily caps.',
};

/**
 * The nav as a viewer sees it. While BILLING_ENFORCED is off the billing page
 * holds budgets only, so it is named for that. The caller (a server component)
 * reads the switch and passes it in, so this module stays env-free for the
 * client sub-nav.
 */
export function settingsNavFor(opts: { billing: boolean }): SettingsNavGroup[] {
  if (opts.billing) return SETTINGS_NAV;
  return SETTINGS_NAV.map((g) => ({
    ...g,
    items: g.items.map((i) => (i.id === 'billing' ? { ...i, ...BUDGETS_ONLY } : i)),
  }));
}

/**
 * True when a team section shows the viewer values only: they hold none of
 * the permissions behind its controls (team overrides applied). Your own
 * sections are never read-only. The server enforces each write either way;
 * this only decides what renders.
 */
export function settingsReadOnly(id: SettingsSectionId, perms: Readonly<Record<Permission, boolean>>): boolean {
  const item = SETTINGS_ITEMS.find((i) => i.id === id);
  if (!item?.manage) return false;
  return !item.manage.some((p) => perms[p]);
}

/** The section a settings path belongs to, or null (the index, or not settings). */
export function settingsItemFor(pathname: string): SettingsNavItem | null {
  for (const item of SETTINGS_ITEMS) {
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) return item;
    if (item.alsoMatches?.some((p) => pathname.startsWith(p))) return item;
  }
  return null;
}

/**
 * Where the mobile header's back arrow goes. A section goes back to the
 * settings index; a page inside a section goes back to its section.
 */
export function settingsBackHref(pathname: string): string | null {
  const item = settingsItemFor(pathname);
  if (!item) return null;
  return pathname === item.href ? SETTINGS_INDEX_HREF : item.href;
}

/**
 * Old `/app/settings#<anchor>` and `?section=<id>` links, from before settings
 * had routes. Anchors never reach the server, so the index page resolves them
 * in the browser; `?section=` is resolved on the server.
 */
export const LEGACY_SETTINGS_ANCHORS: Record<string, string> = {
  'agent-backends': '/app/settings/models',
  'runner-tokens': '/app/settings/runners',
  'inference-spending': '/app/settings/models',
  'provider-keys': '/app/settings/models',
  connectors: '/app/settings/connections',
  notifications: '/app/settings/notifications',
  github: '/app/settings/integrations',
  vercel: '/app/settings/integrations',
  timezone: '/app/settings/team',
  'workspace-ci-policy': '/app/settings/workspaces',
  'danger-zone': '/app/settings/workspaces',
};

/** Resolve a legacy anchor or `section` value (with or without `#`). */
export function legacySettingsTarget(anchorOrSection: string | null | undefined): string | null {
  if (!anchorOrSection) return null;
  const key = anchorOrSection.replace(/^#/, '').trim().toLowerCase();
  return LEGACY_SETTINGS_ANCHORS[key] ?? null;
}
