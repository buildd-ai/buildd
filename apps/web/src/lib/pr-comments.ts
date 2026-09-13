/**
 * Rank a PR's issue comments for `get_pr`'s `includeComments` opt-in.
 *
 * buildd deposits its own decision trail on a PR as comments — the sticky
 * activity log (`@/lib/pr-activity-comment`), conflict warnings, retry
 * supersession notices — all posted under the GitHub App's own bot login.
 * That is the record of what has already been decided about this PR, and it
 * must surface before human discussion, which in turn must surface before
 * third-party bot/CI noise (github-actions, dependabot, vercel, …).
 *
 * Bounded rather than a raw dump: `MAX_COMMENTS_RETURNED` total, kept in
 * (buildd → human → other-bot) tier order, oldest-first within a tier so a
 * decision trail reads chronologically. Excess is reported as `omitted`, not
 * silently dropped.
 */
import { truncate } from '@buildd/core/knowledge-store';

/** Per-comment body cap — a comment is a decision pointer, not the record itself. */
export const MAX_COMMENT_BODY_CHARS = 500;

/** Total comments returned, across all tiers combined. */
export const MAX_COMMENTS_RETURNED = 10;

export type PrCommentKind = 'buildd' | 'human' | 'bot';

export interface RawPrComment {
  id?: number;
  user?: { login?: string | null; type?: string | null } | null;
  body?: string | null;
  created_at?: string | null;
  html_url?: string | null;
}

export interface RankedPrComment {
  author: string;
  kind: PrCommentKind;
  at: string | null;
  body: string;
  url: string | null;
}

export interface RankedPrComments {
  items: RankedPrComment[];
  total: number;
  omitted: number;
}

const TIER_ORDER: Record<PrCommentKind, number> = { buildd: 0, human: 1, bot: 2 };

function classify(comment: RawPrComment, appBotLogin: string): PrCommentKind {
  const login = comment.user?.login ?? '';
  if (login.toLowerCase() === appBotLogin.toLowerCase()) return 'buildd';
  if (comment.user?.type === 'Bot') return 'bot';
  return 'human';
}

export function rankPrComments(raw: RawPrComment[], appBotLogin: string): RankedPrComments {
  const mapped: RankedPrComment[] = raw
    .filter((c): c is RawPrComment & { body: string } => typeof c.body === 'string' && c.body.trim().length > 0)
    .map((c) => ({
      author: c.user?.login ?? 'unknown',
      kind: classify(c, appBotLogin),
      at: c.created_at ?? null,
      body: truncate(c.body.trim(), MAX_COMMENT_BODY_CHARS),
      url: c.html_url ?? null,
    }))
    .sort((a, b) => {
      const tierDiff = TIER_ORDER[a.kind] - TIER_ORDER[b.kind];
      if (tierDiff !== 0) return tierDiff;
      return (a.at ?? '').localeCompare(b.at ?? '');
    });

  const items = mapped.slice(0, MAX_COMMENTS_RETURNED);
  return { items, total: mapped.length, omitted: mapped.length - items.length };
}
