/**
 * `get_visual_review` (docs/design/visual-qa-human-review.md, Chat): the
 * mission's visual review as text the assistant can report from. Registered
 * in registry.ts (CHAT_NATIVE_TOOL_SPECS, a read) and run by tools.ts through
 * the in-process API, so it reaches only `GET /api/missions/:id` (for the
 * mission ref) and `GET /api/missions/:id/visual-review` (the auditor-scoped
 * model), both as the signed-in user and inside the conversation's reach.
 *
 * Text only: never an image, a download link or a signed URL. The card in the
 * feed shows the screens; the assistant has not seen them and must not say so.
 * There is no write counterpart: decisions are the human's, on the card.
 */
import type { ApiFn } from '@buildd/core/mcp-tools';
import type { VisualReviewCell, VisualReviewModel } from '@buildd/shared';
import { describeVisualPhase } from '@/lib/visual-review-model';

const textOut = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

const VIEWPORT_WORD = { mobile: 'phone', desktop: 'desktop' } as const;
const DECISION_WORD = { looks_right: 'looks right', needs_fix: 'needs fix' } as const;
const RELATION_WORD = { agree: 'agreed', dispute: 'disagreed', waive: 'waived' } as const;
const STATUS_WORD: Record<string, string> = {
  pending: 'queued', assigned: 'starting', in_progress: 'in progress', waiting_input: 'waiting on you',
  completed: 'done', failed: 'failed', cancelled: 'cancelled',
};

/** Unsure first, then issues, then ok; a route keeps its phone and desktop rows together. */
const RANK: Record<string, number> = { unsure: 0, issue: 1, ok: 2 };

function one(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function cellLine(c: VisualReviewCell): string {
  const e = c.current;
  const bits = [
    `${VIEWPORT_WORD[c.viewport]}${c.variant ? ` (${c.variant})` : ''}`,
    `round ${e.round}`,
    `agent: ${e.agentVerdict}`,
    e.finding ? `"${one(e.finding)}"` : 'no finding',
    e.review
      ? `you: ${DECISION_WORD[e.review.decision]} (${RELATION_WORD[e.review.relation]})${e.review.note ? `, note "${one(e.review.note)}"` : ''}`
      : c.needsHuman ? 'you: not reviewed yet, needs your call' : 'you: not reviewed yet',
  ];
  const fix = e.fixTask;
  if (fix) {
    const pr = fix.prNumber ? `, PR #${fix.prNumber}${fix.mergedAt ? ' merged' : ''}` : '';
    bits.push(`fix: ${fix.mergedAt ? 'merged' : STATUS_WORD[fix.status] ?? fix.status}${pr} (task ${fix.id.slice(0, 8)})`);
  }
  return `  - ${bits.join('; ')}`;
}

export function formatVisualReview(model: VisualReviewModel, missionTitle: string | null): string {
  const head = missionTitle ? `Visual review of "${missionTitle}"` : 'Visual review';
  if (model.phase === 'off') return `${head}: No visual audit on this mission.`;
  const copy = describeVisualPhase(model);
  const s = model.summary;
  const lines = [
    `${head}: ${copy.label}. ${copy.detail}`,
    `Screens: ${s.shots} current across ${s.rounds} round${s.rounds === 1 ? '' : 's'}; agent said ${s.ok} ok, ${s.issues} issue${s.issues === 1 ? '' : 's'}, ${s.unsure} unsure; ${s.awaitingHuman} await the user; ${s.reviewed} decided by the user; ${s.openFixes} fix${s.openFixes === 1 ? '' : 'es'} open.`,
  ];
  if (model.cells.length === 0) {
    lines.push('No screenshots yet.');
  } else {
    const byRoute = new Map<string, VisualReviewCell[]>();
    for (const c of model.cells) byRoute.set(c.route, [...(byRoute.get(c.route) ?? []), c]);
    const routes = [...byRoute.entries()]
      .map(([route, cells]) => ({ route, cells, rank: Math.min(...cells.map(c => RANK[c.effectiveVerdict] ?? 3)) }))
      .sort((a, b) => a.rank - b.rank || a.route.localeCompare(b.route));
    for (const r of routes) {
      lines.push(`${r.route}:`);
      const cells = [...r.cells].sort((a, b) => (RANK[a.current.agentVerdict] ?? 3) - (RANK[b.current.agentVerdict] ?? 3) || a.viewport.localeCompare(b.viewport));
      for (const c of cells) lines.push(cellLine(c));
    }
  }
  lines.push('You have not seen these images; the card in the chat shows them. The user decides each screen there (Looks right / Needs fix).');
  return lines.join('\n');
}

export async function runGetVisualReview(api: ApiFn, input: Record<string, unknown>) {
  const missionId = typeof input.missionId === 'string' ? input.missionId.trim() : '';
  if (!missionId) return textOut('Error: name the mission (missionId).', true);
  const id = encodeURIComponent(missionId);
  const mission = await api(`/api/missions/${id}`) as { title?: unknown; mission?: { title?: unknown } } | null;
  const title = typeof mission?.title === 'string' ? mission.title
    : typeof mission?.mission?.title === 'string' ? mission.mission.title : null;
  const out = await api(`/api/missions/${id}/visual-review`) as { model?: VisualReviewModel } | null;
  if (!out?.model) return textOut('Error: the visual review could not be read.', true);
  return textOut(formatVisualReview(out.model, title));
}
