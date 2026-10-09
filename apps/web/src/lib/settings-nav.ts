/**
 * Settings information architecture: one source of truth for the settings
 * sub-nav (desktop), the settings index list (mobile), the mobile header's
 * title and back link, and the redirects that keep old `/app/settings#anchor`
 * links working.
 *
 * Every item is its own route so a section is linkable. Groups are labels
 * only; they have no page of their own.
 */

export type SettingsSectionId =
  | 'account'
  | 'team'
  | 'roles'
  | 'budgets'
  | 'billing'
  | 'workspaces'
  | 'models'
  | 'runners'
  | 'github'
  | 'notifications'
  | 'connectors'
  | 'storage';

export interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  href: string;
  /** One line under the label on the settings index. */
  description: string;
  /** Other path prefixes that belong to this section (detail pages). */
  alsoMatches?: string[];
  /** Listed only while BILLING_ENFORCED is on (see settingsNavFor). */
  billingOnly?: boolean;
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_INDEX_HREF = '/app/settings';

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'You and your team',
    items: [
      {
        id: 'account',
        label: 'Profile',
        href: '/app/settings/account',
        description: 'Your sign-in, preferences, and standing rules for chat.',
      },
      {
        id: 'team',
        label: 'Team',
        href: '/app/settings/team',
        description: 'Who is on the team, what each person can change, and the team timezone.',
      },
      {
        id: 'roles',
        label: 'Roles',
        href: '/app/settings/roles',
        description: 'The agents on the team: what each one does, its model and its tools.',
      },
      {
        id: 'budgets',
        label: 'Budgets',
        href: '/app/settings/budgets',
        description: 'What you and the team spend, and daily caps.',
      },
      {
        id: 'billing',
        label: 'Billing',
        href: '/app/settings/billing',
        description: 'Your plan, seats and invoices.',
        billingOnly: true,
      },
    ],
  },
  {
    label: 'Agents and workspaces',
    items: [
      {
        id: 'workspaces',
        label: 'Workspaces',
        href: '/app/settings/workspaces',
        description: 'Each repo agents work in: delivery, merge policy and where its work runs.',
        alsoMatches: ['/app/settings/workspace/'],
      },
      {
        id: 'models',
        label: 'Models',
        href: '/app/settings/models',
        description: 'Model keys and sign-ins, which model backs each tier, and AI features.',
      },
      {
        id: 'runners',
        label: 'Runners',
        href: '/app/settings/runners',
        description: 'Runner tokens, the cloud runner and Cloudflare.',
      },
    ],
  },
  {
    label: 'Integrations',
    items: [
      {
        id: 'github',
        label: 'GitHub and Vercel',
        href: '/app/settings/github',
        description: 'Repository access and preview deploys.',
      },
      {
        id: 'notifications',
        label: 'Notifications',
        href: '/app/settings/notifications',
        description: 'Send alerts to Pushover, Slack, Discord or any webhook.',
      },
      {
        id: 'connectors',
        label: 'MCP connectors',
        href: '/app/settings/connectors',
        description: 'Outside tools your agents can call, and which workspaces get them.',
      },
      {
        id: 'storage',
        label: 'Storage',
        href: '/app/settings/storage',
        description: 'The bucket where run evidence is kept: logs, test reports and transcripts.',
      },
    ],
  },
];

export const SETTINGS_ITEMS: SettingsNavItem[] = SETTINGS_NAV.flatMap((g) => g.items);

/**
 * The nav as a viewer sees it. Billing is hidden entirely while
 * BILLING_ENFORCED is off; the caller (a server component) reads the switch
 * and passes it in, so this module stays env-free for the client sub-nav.
 */
export function settingsNavFor(opts: { billing: boolean }): SettingsNavGroup[] {
  return SETTINGS_NAV
    .map((g) => ({ ...g, items: g.items.filter((i) => opts.billing || !i.billingOnly) }))
    .filter((g) => g.items.length > 0);
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
  connectors: '/app/settings/connectors',
  notifications: '/app/settings/notifications',
  github: '/app/settings/github',
  vercel: '/app/settings/github',
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
