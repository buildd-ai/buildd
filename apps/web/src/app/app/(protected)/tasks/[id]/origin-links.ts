import type { TaskOriginLink, TaskOriginLinkKey } from '@/lib/task-origin';

/**
 * The Origin row's links as labelled cards. A bare row of accent links
 * ("Agent run  Mission  PR #12") left readers guessing what each one was, and
 * orange is reserved for action and live work — so each card names its kind
 * first, then the thing, in neutral ink.
 */
export interface OriginLinkCard {
  key: string;
  /** What this link is: "Mission", "Parent task", "Pull request". */
  kind: string;
  /** The linked thing's name, or a call to open it when only a fallback exists. */
  title: string;
  href: string;
  external: boolean;
}

const KIND: Record<TaskOriginLinkKey, { kind: string; fallback: string; open: string }> = {
  worker: { kind: 'Created by', fallback: 'Agent run', open: 'Open the agent’s task' },
  mission: { kind: 'Mission', fallback: 'Mission', open: 'Open mission' },
  schedule: { kind: 'Schedule', fallback: 'Schedule', open: 'Open schedules' },
  parentTask: { kind: 'Parent task', fallback: 'Parent task', open: 'Open task' },
  pr: { kind: 'Pull request', fallback: 'PR', open: 'Open on GitHub' },
  run: { kind: 'CI run', fallback: 'CI run', open: 'Open on GitHub' },
};

export function originLinkCards(links: TaskOriginLink[]): OriginLinkCard[] {
  return links.map(link => {
    const k = KIND[link.key];
    const title = link.key === 'pr'
      ? link.label.replace(/^PR\s+/, '')
      : link.label === k.fallback ? k.open : link.label;
    return {
      key: `${link.key}-${link.href}`,
      kind: k.kind,
      title,
      href: link.href,
      external: !link.href.startsWith('/'),
    };
  });
}
