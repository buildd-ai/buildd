// @ui-copy
/**
 * `/app/specs`, the way to a team's specs (owner, Oct 14: "where do I find
 * specs if not on them?"). The nav keeps five items, so this route sits
 * under Missions: with one workspace holding specs it opens that
 * workspace's index, else it lists the workspaces that have some. Pure.
 */
export interface HubWorkspace {
  id: string;
  name: string;
  /** Specs counted as the index counts them: not products or areas, not retired or superseded. */
  specs: number;
  /** Of those, how many have a revision waiting for approval. */
  waiting: number;
}

export type HubTarget =
  | { kind: 'redirect'; href: string }
  | { kind: 'list'; workspaces: Array<HubWorkspace & { href: string; words: string }> }
  | { kind: 'empty' };

export const workspaceSpecsHref = (id: string) => `/app/workspaces/${id}/specs`;

/** "16 specs, 2 waiting for approval". */
export function hubWords(w: Pick<HubWorkspace, 'specs' | 'waiting'>): string {
  const specs = `${w.specs} spec${w.specs === 1 ? '' : 's'}`;
  return w.waiting ? `${specs}, ${w.waiting} waiting for approval` : specs;
}

export function hubTarget(all: readonly HubWorkspace[]): HubTarget {
  const withSpecs = all.filter((w) => w.specs > 0);
  if (withSpecs.length === 1) return { kind: 'redirect', href: workspaceSpecsHref(withSpecs[0].id) };
  if (withSpecs.length === 0) return { kind: 'empty' };
  return {
    kind: 'list',
    workspaces: [...withSpecs]
      .sort((a, b) => b.waiting - a.waiting || b.specs - a.specs || a.name.localeCompare(b.name))
      .map((w) => ({ ...w, href: workspaceSpecsHref(w.id), words: hubWords(w) })),
  };
}
