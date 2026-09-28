/**
 * `get_visual_review` (docs/design/visual-qa-human-review.md, Chat): the
 * mission's visual review as text the assistant can report from. Registered
 * in registry.ts (CHAT_NATIVE_TOOL_SPECS, a read) and run by tools.ts through
 * the in-process API, so it reaches only `GET /api/missions/:id` (for the
 * mission ref), `GET /api/missions/:id/visual-review` (the auditor-scoped
 * model) and `GET /api/missions/:id/artifacts` (manual visual evidence), all
 * as the signed-in user and inside the conversation's reach.
 *
 * Text only: never an image, a download link or a signed URL. The card in the
 * feed shows the screens; the assistant has not seen them and must not say so.
 * There is no write counterpart: decisions are the human's, on the card.
 */
import type { ApiFn } from '@buildd/core/mcp-tools';
import type { VisualReviewModel } from '@buildd/shared';
import { formatVisualReview as formatShared, missionArtifacts, type VisualEvidenceArtifact } from '@buildd/core/visual-review-text';

const textOut = (text: string, isError = false) => ({ content: [{ type: 'text' as const, text }], ...(isError ? { isError } : {}) });

/** The shared text (packages/core/visual-review-text.ts), chat audience: no links. */
export function formatVisualReview(model: VisualReviewModel, missionTitle: string | null, artifacts: VisualEvidenceArtifact[] | null = null): string {
  return formatShared(model, missionTitle, { audience: 'chat', artifacts });
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
  return textOut(formatVisualReview(out.model, title, await missionArtifacts(api, id)));
}
