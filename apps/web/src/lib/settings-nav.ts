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
  | 'budgets'
  | 'runners'
  | 'providers'
  | 'github'
  | 'notifications'
  | 'connectors'
  | 'ai'
  | 'models'
  | 'workspaces';

export interface SettingsNavItem {
  id: SettingsSectionId;
  label: string;
  href: string;
  /** One line under the label on the settings index. */
  description: string;
  /** Other path prefixes that belong to this section (detail pages). */
  alsoMatches?: string[];
}

export interface SettingsNavGroup {
  label: string;
  items: SettingsNavItem[];
}

export const SETTINGS_INDEX_HREF = '/app/settings';

export const SETTINGS_NAV: SettingsNavGroup[] = [
  {
    label: 'Account',
    items: [
      {
        id: 'account',
        label: 'Profile',
        href: '/app/settings/account',
        description: 'Your sign-in, your teams, and which key you use.',
      },
    ],
  },
  {
    label: 'Team',
    items: [
      {
        id: 'team',
        label: 'Members',
        href: '/app/settings/team',
        description: 'Who is on the team, what each person can change, and the team timezone.',
      },
      {
        id: 'budgets',
        label: 'Budgets',
        href: '/app/settings/budgets',
        description: 'What you and the team spend, and daily caps.',
      },
    ],
  },
  {
    label: 'Connections',
    items: [
      {
        id: 'runners',
        label: 'Runners',
        href: '/app/settings/runners',
        description: 'The Claude or Codex sign-in your runners use, and runner tokens.',
      },
      {
        id: 'providers',
        label: 'Model providers',
        href: '/app/settings/providers',
        description: 'OpenRouter, Anthropic or OpenAI keys for server-side AI.',
      },
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
    ],
  },
  {
    label: 'AI',
    items: [
      {
        id: 'ai',
        label: 'AI features',
        href: '/app/settings/ai',
        description: 'Interactive AI and where server-side features run.',
      },
      {
        id: 'models',
        label: 'Model tiers',
        href: '/app/settings/models',
        description: 'Which model backs each tier.',
      },
    ],
  },
  {
    label: 'Workspaces',
    items: [
      {
        id: 'workspaces',
        label: 'Workspaces',
        href: '/app/settings/workspaces',
        description: 'CI policy, merge policy and per-workspace config.',
        alsoMatches: ['/app/settings/workspace/'],
      },
    ],
  },
];

export const SETTINGS_ITEMS: SettingsNavItem[] = SETTINGS_NAV.flatMap((g) => g.items);

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
  'agent-backends': '/app/settings/runners',
  'runner-tokens': '/app/settings/runners',
  'inference-spending': '/app/settings/ai',
  'provider-keys': '/app/settings/providers',
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
