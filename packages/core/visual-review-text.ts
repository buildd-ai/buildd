/**
 * A mission's visual review as words (docs/design/visual-qa-human-review.md).
 * Pure; safe on the client. The one place phase copy is written
 * (`describeVisualPhase`, re-exported by apps/web/src/lib/visual-review-model.ts)
 * and the one text rendering of a `VisualReviewModel`, read by the chat's
 * `get_visual_review` tool and by the MCP `get_visual_review` action.
 *
 * Audience:
 * - `chat` (default): the artifact page link per screenshot (relative to the
 *   app, or on `baseUrl` when given), so the assistant can hand the user a
 *   link, but never an image or download reference. The chat card shows the
 *   screens; the assistant has not seen them and must not say so.
 * - `mcp`: a link per screenshot (the artifact page and the download route
 *   the app already uses), full task ids.
 *
 * "Other visual evidence": a mission can be checked by hand as well as by
 * the auditor. Given the mission's artifacts (one list call, no per-artifact
 * read), screenshots the auditor did not write and reports whose title or key
 * names visual validation are listed too, so the text never says "no visual
 * QA" over a manual validation report.
 */
import type { VisualReviewAuditTask, VisualReviewCell, VisualReviewModel, VisualReviewNeedsYou } from '@buildd/shared';

const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

/**
 * The one place phase copy is written. `label` is the short line (a Band
 * cell, a chip); `detail` the sentence under it. Plain words, no dash
 * placeholders.
 */
export function describeVisualPhase(
  model: Pick<VisualReviewModel, 'phase' | 'progress' | 'summary'> & { needsYou?: VisualReviewNeedsYou | null },
): { label: string; detail: string } {
  const { summary: s, progress } = model;
  switch (model.phase) {
    case 'off':
      return { label: 'Off', detail: 'No visual audit on this mission.' };
    case 'waiting_deps':
      return { label: 'Waiting', detail: 'The visual audit starts when the work it checks has landed.' };
    case 'queued':
      return { label: 'Queued', detail: 'Waiting for a browser runner to pick up the visual audit.' };
    case 'no_browser_runner':
      return { label: 'No browser runner', detail: 'The visual audit is waiting: no browser runner is online for this workspace.' };
    case 'capturing': {
      const captured = progress?.captured ?? 0;
      const label = progress?.expected != null ? `Capturing ${captured} of ${progress.expected}` : `Capturing ${captured}`;
      return { label, detail: `${plural(captured, 'screen')} captured so far.` };
    }
    case 'boot_failed':
      return { label: 'App did not boot', detail: 'The app did not boot for the visual audit, so nothing was checked.' };
    case 'stalled':
      return { label: 'Stalled', detail: 'The visual audit stalled on its runner. Retry it, or skip this audit.' };
    case 'failed':
      return { label: 'Failed', detail: 'The visual audit failed before it finished. Retry it, or skip this audit.' };
    case 'needs_you': {
      const n = s.awaitingHuman;
      // Older callers pass no reason: infer it from the counts.
      const reason = model.needsYou?.reason ?? (n > 0 ? 'unsure' : 'round_cap');
      if (reason === 'question') {
        const prompt = model.needsYou?.prompt?.trim();
        return { label: 'Question', detail: prompt ? `The visual audit has a question for you: ${prompt}` : 'The visual audit has a question for you.' };
      }
      if (reason === 'unsure' && n > 0) {
        return { label: `${n} to review`, detail: `${plural(n, 'screen')} the agent was unsure about ${n === 1 ? 'needs' : 'need'} your call.` };
      }
      return { label: 'Your call', detail: `Issues remain after ${plural(s.rounds, 'round')} of fixes. Decide whether to fix or waive them.` };
    }
    case 'fixing':
      return { label: `Fixing ${s.openFixes}`, detail: `${plural(s.openFixes, 'fix', 'fixes')} in progress. The audit re-checks after they land.` };
    case 'reviewed': {
      // What the human decided wins over the agent's verdict here.
      const ok = s.effectiveOk ?? s.ok;
      const issues = s.effectiveIssues ?? s.issues;
      const head = `${ok} of ${s.shots} ok`;
      const parts: string[] = [];
      if (issues > 0) parts.push(plural(issues, 'issue'));
      if (s.reviewed > 0) parts.push(`${s.reviewed} reviewed`);
      return { label: head, detail: parts.length > 0 ? `${parts.join(', ')}.` : `${head}.` };
    }
  }
}

export interface FormatVisualReviewOptions {
  /** Default `chat`. */
  audience?: 'chat' | 'mcp';
  /** The app origin the links are built on (`chat`: optional, links are app-relative without it). */
  baseUrl?: string;
  missionId?: string;
  missionStatus?: string | null;
  /** `mcp`: the mission's `completedAt`; with status `completed`, adds whether an audit came first. */
  missionCompletedAt?: string | null;
  /** List only the screens that need a human decision; count the rest. */
  awaitingOnly?: boolean;
  /** The mission's artifacts (GET /api/missions/:id/artifacts); null or absent: no evidence section. */
  artifacts?: VisualEvidenceArtifact[] | null;
}

/** The fields of an artifact row the evidence section reads. Never its image. */
export interface VisualEvidenceArtifact {
  id: string;
  type: string;
  title?: string | null;
  key?: string | null;
  content?: string | null;
  metadata?: unknown;
  updatedAt?: string | null;
  createdAt?: string | null;
}

/** Artifact types a written validation can be filed as. */
const REPORT_TYPES = new Set(['report', 'analysis', 'summary', 'walkthrough']);
/** "Visual validation", "visual QA", "visual-review", "screenshot check", ... in a title or key. */
const VALIDATION_RE = /visual[\s_-]*(validation|qa|review|check|verification|test)|screenshots?[\s_-]*(review|check|validation)/i;
const SHOTS_SHOWN = 5;
const REPORTS_SHOWN = 3;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const stamp = (a: VisualEvidenceArtifact) => {
  const ms = Date.parse(a.updatedAt ?? a.createdAt ?? '');
  return Number.isNaN(ms) ? 0 : ms;
};

/**
 * The mission's visual evidence besides the audit: screenshots with no
 * `metadata.qa` that the model does not already show, and validation-like
 * reports. Newest first.
 */
export function otherVisualEvidence(
  artifacts: VisualEvidenceArtifact[] | null | undefined,
  model: Pick<VisualReviewModel, 'cells'>,
): { screenshots: VisualEvidenceArtifact[]; reports: VisualEvidenceArtifact[] } {
  const shown = new Set<string>();
  for (const c of model.cells) {
    shown.add(c.current.shot.id);
    for (const h of c.history ?? []) shown.add(h.shot.id);
  }
  const screenshots: VisualEvidenceArtifact[] = [];
  const reports: VisualEvidenceArtifact[] = [];
  for (const a of artifacts ?? []) {
    if (!a || typeof a.id !== 'string') continue;
    if (a.type === 'screenshot') {
      if (shown.has(a.id) || (isObject(a.metadata) && isObject(a.metadata.qa))) continue;
      screenshots.push(a);
    } else if (REPORT_TYPES.has(a.type) && VALIDATION_RE.test(`${a.title ?? ''} ${a.key ?? ''}`)) {
      reports.push(a);
    }
  }
  const newest = (x: VisualEvidenceArtifact, y: VisualEvidenceArtifact) => stamp(y) - stamp(x);
  return { screenshots: screenshots.sort(newest), reports: reports.sort(newest) };
}

const VIEWPORT_IN_TITLE: Array<[RegExp, string]> = [
  [/\b(mobile|phone|iphone)\b/i, 'phone'],
  [/\btablet|ipad\b/i, 'tablet'],
  [/\bdesktop\b/i, 'desktop'],
];

function viewportOf(a: VisualEvidenceArtifact): string | null {
  const meta = isObject(a.metadata) ? a.metadata : {};
  const v = meta.viewport;
  if (typeof v === 'string' && v.trim()) return VIEWPORT_WORD[v.trim() as keyof typeof VIEWPORT_WORD] ?? one(v);
  for (const [re, word] of VIEWPORT_IN_TITLE) if (re.test(a.title ?? '')) return word;
  const size = (a.title ?? '').match(/\b\d{3,4}\s*[x×]\s*\d{3,4}\b/);
  return size ? size[0].replace(/\s+/g, '') : null;
}

const VERDICT_RE = /\b(verdict|result|outcome|conclusion|status|passed|failed|pass|fail)\b/i;
const MAX_PREVIEW = 160;

/** The report's verdict line, else its first line of prose. Markdown marks stripped. */
function previewOf(a: VisualEvidenceArtifact): string | null {
  const lines = (a.content ?? '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const plain = (l: string) => one(l.replace(/^(#+|>|[-*+]|\d+\.)\s*/, '').replace(/[*_`]/g, ''));
  const pick = lines.map(plain).find(l => VERDICT_RE.test(l) && l.split(' ').length > 2)
    ?? lines.filter(l => !l.startsWith('#')).map(plain).find(Boolean)
    ?? null;
  if (!pick) return null;
  return pick.length > MAX_PREVIEW ? `${pick.slice(0, MAX_PREVIEW - 1)}…` : pick;
}

/**
 * The bounded read: only the types the section can show, the newest
 * EVIDENCE_LIMIT of them, and each body cut to 2KB in SQL (previewOf reads
 * the first lines of at most REPORTS_SHOWN reports). A diff or plan body is
 * never fetched.
 */
const EVIDENCE_LIMIT = 100;
const EVIDENCE_QUERY = `types=${['screenshot', ...REPORT_TYPES].join(',')}&limit=${EVIDENCE_LIMIT}&preview=1`;

/**
 * The mission's artifacts, for the evidence section: one list read
 * (GET /api/missions/:id/artifacts) through the caller's own api, so its
 * access check applies. A failure drops the section, never the review.
 */
export async function missionArtifacts(
  api: (endpoint: string) => Promise<unknown>,
  encodedMissionId: string,
): Promise<VisualEvidenceArtifact[] | null> {
  try {
    const data = await api(`/api/missions/${encodedMissionId}/artifacts?${EVIDENCE_QUERY}`) as { artifacts?: unknown } | null;
    return Array.isArray(data?.artifacts) ? data.artifacts as VisualEvidenceArtifact[] : null;
  } catch {
    return null;
  }
}

function evidenceLines(ev: ReturnType<typeof otherVisualEvidence>, o: FormatVisualReviewOptions): string[] {
  const mcp = o.audience === 'mcp';
  const link = (a: VisualEvidenceArtifact) => ` (${pageLink(o, a.id)})`;
  const title = (a: VisualEvidenceArtifact) => `"${one(a.title || a.key || 'Untitled')}"`;
  const parts = [ev.screenshots.length > 0 && plural(ev.screenshots.length, 'screenshot'), ev.reports.length > 0 && plural(ev.reports.length, 'report')].filter(Boolean);
  const out = [`Other visual evidence (${parts.join(', ')}):`];
  for (const a of ev.screenshots.slice(0, SHOTS_SHOWN)) {
    const vp = viewportOf(a);
    const at = when(a.updatedAt ?? a.createdAt);
    out.push(`  - screenshot ${title(a)}${vp ? ` (${vp})` : ''}${at ? `, ${at}` : ''}${link(a)}`);
  }
  const moreShots = ev.screenshots.length - SHOTS_SHOWN;
  if (moreShots > 0) out.push(`  - ${plural(moreShots, 'more screenshot')} not shown`);
  for (const a of ev.reports.slice(0, REPORTS_SHOWN)) {
    const at = when(a.updatedAt ?? a.createdAt);
    const preview = previewOf(a);
    out.push(`  - ${a.type} ${title(a)}${at ? `, updated ${at}` : ''}${link(a)}${preview ? `: ${preview}` : ''}`);
  }
  const moreReports = ev.reports.length - REPORTS_SHOWN;
  if (moreReports > 0) out.push(`  - ${plural(moreReports, 'more report')} not shown`);
  if (mcp && (moreShots > 0 || moreReports > 0) && o.missionId) out.push(`  list_artifacts missionId=${o.missionId} lists them all.`);
  return out;
}

const VIEWPORT_WORD = { mobile: 'phone', desktop: 'desktop' } as const;
const DECISION_WORD = { looks_right: 'looks right', needs_fix: 'needs fix' } as const;
const RELATION_WORD = { agree: 'agreed', dispute: 'disagreed', waive: 'waived' } as const;
const STATUS_WORD: Record<string, string> = {
  pending: 'queued', assigned: 'starting', in_progress: 'in progress', waiting_input: 'waiting on you',
  completed: 'done', failed: 'failed', cancelled: 'cancelled',
};

/** Unsure first, then issues, then ok; a route keeps its phone and desktop rows together. */
const RANK: Record<string, number> = { unsure: 0, issue: 1, ok: 2 };

const one = (s: string) => s.replace(/\s+/g, ' ').trim();

/** An artifact's page in the app: a link a person opens, never the image itself. */
const pageLink = (o: FormatVisualReviewOptions, id: string) =>
  `${(o.baseUrl ?? '').replace(/\/+$/, '')}/app/artifacts/${encodeURIComponent(id)}`;

function cellLine(c: VisualReviewCell, o: FormatVisualReviewOptions): string {
  const mcp = o.audience === 'mcp';
  const who = mcp ? 'human' : 'you';
  const e = c.current;
  const bits = [
    `${VIEWPORT_WORD[c.viewport]}${c.variant ? ` (${c.variant})` : ''}`,
    `round ${e.round}`,
    `agent: ${e.agentVerdict}`,
    e.finding ? `"${one(e.finding)}"` : 'no finding',
    e.review
      ? `${who}: ${DECISION_WORD[e.review.decision]} (${RELATION_WORD[e.review.relation]})${e.review.note ? `, note "${one(e.review.note)}"` : ''}`
      : c.needsHuman ? `${who}: not reviewed yet, ${mcp ? 'needs review' : 'needs your call'}` : `${who}: not reviewed yet`,
  ];
  const fix = e.fixTask;
  if (fix) {
    const pr = fix.prNumber ? `, PR #${fix.prNumber}${fix.mergedAt ? ' merged' : ''}` : '';
    bits.push(`fix: ${fix.mergedAt ? 'merged' : STATUS_WORD[fix.status] ?? fix.status}${pr} (task ${mcp ? fix.id : fix.id.slice(0, 8)})`);
  }
  if (mcp) {
    const base = (o.baseUrl ?? '').replace(/\/+$/, '');
    bits.push(`shot ${pageLink(o, e.shot.id)} (image ${base}/api/artifacts/${encodeURIComponent(e.shot.id)}/download)`);
  } else {
    // A link the user can open; the image itself never reaches the model.
    bits.push(`link ${pageLink(o, e.shot.id)}`);
  }
  return `  - ${bits.join('; ')}`;
}

/** `2026-03-10 10:05 UTC`; null for a missing or unparsable time. */
function when(t: string | null | undefined): string | null {
  const ms = t ? Date.parse(t) : NaN;
  return Number.isNaN(ms) ? null : `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function auditLine(a: VisualReviewAuditTask, mcp: boolean): string {
  const id = mcp ? a.id : a.id.slice(0, 8);
  const reasons = [a.errorType, a.why].filter((x): x is string => !!x).map(one);
  const why = reasons.length > 0 ? reasons.join('; ') : null;
  const tail = why ? `: ${why}` : a.status === 'cancelled' || a.status === 'failed' ? ': no reason recorded' : '';
  const times = [when(a.createdAt) && `started ${when(a.createdAt)}`, when(a.endedAt) && `ended ${when(a.endedAt)}`].filter(Boolean);
  return `  - round ${a.round}: ${a.status}${times.length > 0 ? `, ${times.join(', ')}` : ''} (task ${id})${tail}`;
}

/** Q3: did an audit complete before the mission did? Only for a completed mission. */
function checkedBeforeDone(audits: VisualReviewAuditTask[], completedAt: string | null | undefined, evidence: VisualEvidenceArtifact[] = []): string {
  const q = 'Visually checked before the mission was completed:';
  const doneMs = completedAt ? Date.parse(completedAt) : NaN;
  if (Number.isNaN(doneMs)) return `${q} unknown (completion time not recorded).`;
  if (audits.length === 0 && evidence.length > 0) {
    const dated = evidence.filter(a => stamp(a) > 0);
    const before = dated.filter(a => stamp(a) <= doneMs).sort((x, y) => stamp(y) - stamp(x))[0];
    if (before) return `${q} no automatic audit ran; manual evidence dated before completion ("${one(before.title || before.key || 'Untitled')}", ${when(before.updatedAt ?? before.createdAt)}).`;
    return `${q} no automatic audit ran; ${dated.length > 0 ? 'the manual evidence is dated after completion' : 'the manual evidence is undated'}.`;
  }
  if (audits.length === 0) return `${q} no (no visual audit ran).`;
  const completed = audits.filter(a => a.status === 'completed' && when(a.endedAt));
  const before = completed.filter(a => Date.parse(a.endedAt!) <= doneMs);
  if (before.length > 0) {
    const a = before[before.length - 1];
    return `${q} yes (round ${a.round} audit completed ${when(a.endedAt)}).`;
  }
  if (completed.length > 0) {
    const a = completed[0];
    return `${q} no (round ${a.round} audit completed after it, ${when(a.endedAt)}).`;
  }
  const latest = audits[audits.length - 1];
  return `${q} no (no audit completed; latest: round ${latest.round} ${latest.status}).`;
}

/** The MCP closing line: what, if anything, waits on a human, from `needsYou`, never a bare count. */
function needsYouLine(model: VisualReviewModel): string {
  const n = model.summary.awaitingHuman;
  const reason = model.needsYou?.reason;
  if (reason === 'question') {
    const prompt = model.needsYou?.prompt?.trim();
    return `Needs your answer: ${prompt ? one(prompt) : 'the visual audit asked a question (see the mission page).'}`;
  }
  if (n > 0) return `${plural(n, 'screen needs', 'screens need')} your review.`;
  if (reason === 'round_cap' || (model.phase === 'needs_you' && !reason)) {
    return `Needs your decision: issues remain after ${plural(model.summary.rounds, 'round')} (fix or waive).`;
  }
  return 'Nothing needs your review.';
}

export function formatVisualReview(
  model: VisualReviewModel,
  missionTitle: string | null,
  opts: FormatVisualReviewOptions = {},
): string {
  const mcp = opts.audience === 'mcp';
  const named = missionTitle ? `Visual review of "${missionTitle}"` : 'Visual review';
  const doneAt = opts.missionStatus === 'completed' ? when(opts.missionCompletedAt) : null;
  const head = mcp && opts.missionId
    ? `${named} (mission ${opts.missionId}${opts.missionStatus ? `, ${opts.missionStatus}${doneAt ? ` ${doneAt}` : ''}` : ''})`
    : named;
  const audits = model.audits ?? (model.audit ? [model.audit] : []);
  const ev = otherVisualEvidence(opts.artifacts, model);
  const evidence = [...ev.screenshots, ...ev.reports];
  const hasEvidence = evidence.length > 0;
  const q3 = mcp && opts.missionStatus === 'completed' ? `\n${checkedBeforeDone(audits, opts.missionCompletedAt, evidence)}` : '';
  const unseen = ev.screenshots.length > 0 ? 'You have not seen these screenshots; the user opens them from the links above or the mission\'s artifacts.' : null;
  if (model.phase === 'off' && audits.length === 0) {
    if (!hasEvidence) return `${head}: No visual audit on this mission.${q3}`;
    const lines = [`${head}: No automatic visual audit ran; manual visual evidence below.`];
    if (q3) lines.push(q3.slice(1));
    lines.push(...evidenceLines(ev, opts));
    if (!mcp && unseen) lines.push(unseen);
    return lines.join('\n');
  }

  const lines: string[] = [];
  if (model.phase === 'off') {
    lines.push(hasEvidence ? `${head}: the audit captured no screens; other visual evidence below.` : `${head}: no screens were captured.`);
  } else {
    const copy = describeVisualPhase(model);
    lines.push(`${head}: ${copy.label}. ${copy.detail}`);
  }
  if (audits.length > 0) {
    lines.push(`Audit tasks (${audits.length}):`);
    for (const a of audits) lines.push(auditLine(a, mcp));
  }
  if (q3) lines.push(q3.slice(1));
  const s = model.summary;
  const human = mcp ? 'await a human' : 'await the user';
  lines.push(`Screens: ${s.shots} current across ${plural(s.rounds, 'round')}; agent said ${s.ok} ok, ${plural(s.issues, 'issue')}, ${s.unsure} unsure; ${s.awaitingHuman} ${human}; ${s.reviewed} decided by ${mcp ? 'a human' : 'the user'}; ${plural(s.openFixes, 'fix', 'fixes')} open.`);

  const shown = opts.awaitingOnly ? model.cells.filter(c => c.needsHuman) : model.cells;
  if (model.cells.length === 0) {
    if (!hasEvidence) lines.push('No screenshots yet.');
  } else {
    const byRoute = new Map<string, VisualReviewCell[]>();
    for (const c of shown) byRoute.set(c.route, [...(byRoute.get(c.route) ?? []), c]);
    const routes = [...byRoute.entries()]
      .map(([route, cells]) => ({ route, cells, rank: Math.min(...cells.map(c => RANK[c.effectiveVerdict] ?? 3)) }))
      .sort((a, b) => a.rank - b.rank || a.route.localeCompare(b.route));
    for (const r of routes) {
      lines.push(`${r.route}:`);
      const cells = [...r.cells].sort((a, b) => (RANK[a.current.agentVerdict] ?? 3) - (RANK[b.current.agentVerdict] ?? 3) || a.viewport.localeCompare(b.viewport));
      for (const c of cells) lines.push(cellLine(c, opts));
    }
    const left = model.cells.length - shown.length;
    if (left > 0) lines.push(`${plural(left, 'other screen')} not shown (awaitingOnly); call without awaitingOnly for all.`);
  }
  if (hasEvidence) lines.push(...evidenceLines(ev, opts));

  if (mcp) {
    lines.push(needsYouLine(model));
    if (opts.missionId && opts.baseUrl) lines.push(`Decide on the mission page: ${opts.baseUrl.replace(/\/+$/, '')}/app/missions/${encodeURIComponent(opts.missionId)}`);
  } else {
    if (unseen) lines.push(unseen);
    lines.push('You have not seen these images, only their text: give the links when the user asks for the screenshots, and never describe what a screen looks like. The card in the chat shows them; the user decides each screen there (Looks right / Needs fix).');
  }
  return lines.join('\n');
}
