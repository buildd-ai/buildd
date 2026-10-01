/**
 * Advice for the mission decision sheet's `surface_audit_missing` branch: run
 * the visual audit, or waive it? A decision model (Jev) picks one, from what
 * the mission changed. It only recommends. The sheet pre-selects the pick and
 * the person confirms; nothing here writes to a mission or a task.
 *
 * Jev returns a typed label and a confidence, never prose, so the one-sentence
 * reason and the waiver draft are composed here from the label and the same
 * facts the model saw. A draft is a starting point the person edits.
 *
 * Fails soft by construction: no key, a disabled capability, a sensitive
 * workspace, a timeout, a low-confidence pick or a throw all return null, and
 * the sheet then shows both actions with nothing pre-selected.
 *
 * Cached per mission and the set of merged PRs behind it, so reopening the
 * sheet does not spend again. The cache is per server instance (best effort).
 */
import { createHash } from 'node:crypto';
import { SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH } from '@buildd/core/surface-audit';
import type {
  ChoiceQuestion,
  DecisionAccess,
  DecisionReceipt,
  DecisionResult,
  decisionCall,
} from '@buildd/core/decision-client';

export const SURFACE_AUDIT_ADVICE_CAPABILITY = 'surface_audit_advice' as const;
export const SURFACE_AUDIT_ADVICE_DECISION_ID = 'surface_audit_advice';
export const SURFACE_AUDIT_ADVICE_LOG_PREFIX = '[surface-audit-advice]';
export const ADVICE_TIMEOUT_MS = 4_000;
/** Below this the pick is not shown: a wrong pre-selection is worse than none. */
export const ADVICE_MIN_CONFIDENCE = 0.8;
export const ADVICE_MAX_FILES = 20;
export const ADVICE_MAX_TITLES = 10;
const MAX_WAIVER_DRAFT_CHARS = 280;

/** Bump when the question, a definition or the state shape changes. */
export const SURFACE_AUDIT_ADVICE_PROMPT_VERSION = 'sa1';

export type SurfaceAuditRecommendation = 'audit' | 'waive';

export interface SurfaceAuditAdvice {
  recommend: SurfaceAuditRecommendation;
  why: string;
  waiverDraft?: string;
}

export const SURFACE_AUDIT_ADVICE_QUESTION = {
  type: 'choice',
  instructions: {
    question: 'The pull requests in `mission` changed UI files and no visual audit has run. Is a visual audit worth running?',
    rule: 'Judge from the files and the work titles. A change that can alter what a person sees needs the audit; one that cannot does not.',
  },
  criteria: {
    audit: {
      what: 'The changes can alter what a person sees or does on a screen: new or reworked pages, layout, navigation, forms, buttons, copy, responsive behaviour, or a component shared across pages.',
      not_for: 'Renames, moves, type or prop plumbing, and internal refactors that render the same output.',
    },
    waive: {
      what: 'The changes are unlikely to change what is rendered: renames or moves, type or prop plumbing, comments, internal refactors with the same output, or a small tweak to a rarely visited screen.',
      not_for: 'New screens, layout or navigation changes, or edits to a widely shared component.',
    },
  },
} satisfies ChoiceQuestion<SurfaceAuditRecommendation>;

type Questions = { pick: typeof SURFACE_AUDIT_ADVICE_QUESTION };

export interface AdviceFacts {
  uiPaths: string[];
  /** Titles of the completed work that shipped them (a PR's title is its task's). */
  workTitles: string[];
}

/** What the call may see: file paths and work titles. Never a description, a diff or a note. */
export function buildAdviceState(facts: AdviceFacts) {
  return {
    mission: {
      changedUiFileCount: facts.uiPaths.length,
      changedUiFiles: facts.uiPaths.slice(0, ADVICE_MAX_FILES),
      shippedWork: facts.workTitles.slice(0, ADVICE_MAX_TITLES),
    },
  };
}

/** The sorted PR numbers behind the mission's shipped work, hashed: the cache's "head of the merged set". */
export function adviceCacheKey(missionId: string, prNumbers: readonly number[]): string {
  const head = createHash('sha256').update([...new Set(prNumbers)].sort((a, b) => a - b).join(',')).digest('hex').slice(0, 16);
  return `${missionId}:${SURFACE_AUDIT_ADVICE_PROMPT_VERSION}:${head}`;
}

/** The route-ish area a UI file sits in, for the sentence: `apps/web/src/app/app/(protected)/missions/[id]/x.tsx` -> `missions`. */
function areaOf(path: string): string {
  const segs = path.split('/').filter(Boolean);
  const meaningful = segs.slice(0, -1).filter(s => !/^(apps|web|src|app|components|\(.*\))$/.test(s) && !s.startsWith('['));
  return meaningful[0] ?? 'shared components';
}

function areasOf(paths: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const p of paths) counts.set(areaOf(p), (counts.get(areaOf(p)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([a]) => a);
}

function list(items: readonly string[], max = 3): string {
  const shown = items.slice(0, max).join(', ');
  return items.length > max ? `${shown} and ${items.length - max} more` : shown;
}

/** One sentence, plain language, built from the pick and the facts the model saw. */
export function composeAdvice(pick: SurfaceAuditRecommendation, facts: AdviceFacts): SurfaceAuditAdvice {
  const n = facts.uiPaths.length;
  const files = `${n} UI ${n === 1 ? 'file' : 'files'}`;
  const areas = list(areasOf(facts.uiPaths));
  if (pick === 'audit') {
    return {
      recommend: 'audit',
      why: `These changes touch ${files} across ${areas}, which can change what people see, so a visual check is worth running.`,
    };
  }
  const work = facts.workTitles[0]?.trim();
  const draft = (work
    ? `Owner review: "${work}" changed ${files} (${areas}) with no visual change expected, so no visual audit is needed.`
    : `Owner review: ${files} changed (${areas}) with no visual change expected, so no visual audit is needed.`
  ).slice(0, MAX_WAIVER_DRAFT_CHARS);
  return {
    recommend: 'waive',
    why: `These changes to ${files} across ${areas} look unlikely to change what is rendered, so an audit adds little.`,
    ...(draft.trim().length >= SURFACE_AUDIT_WAIVER_MIN_REASON_LENGTH ? { waiverDraft: draft } : {}),
  };
}

export interface AdviceInput extends AdviceFacts {
  missionId: string;
  teamId: string;
  workspaceId: string | null;
  accountId?: string | null;
  userId?: string | null;
  /** `workspaces.gitConfig.dataClass`. A sensitive workspace never sends content out. */
  dataClass?: string | null;
  prNumbers: readonly number[];
}

type DecideFn = typeof decisionCall<Questions>;
type ResolveAccess = (opts: {
  capability: typeof SURFACE_AUDIT_ADVICE_CAPABILITY;
  teamId: string;
  workspaceId: string | null;
  accountId: string | null;
  userId: string | null;
}) => Promise<DecisionAccess>;

export interface AdviceDeps {
  decide?: DecideFn;
  resolveAccess?: ResolveAccess;
  recordReceipt?: (receipt: DecisionReceipt, scope: { teamId: string; accountId: string | null }) => Promise<void>;
  cache?: Map<string, SurfaceAuditAdvice>;
  log?: (line: string) => void;
}

const MAX_CACHE_ENTRIES = 200;
const sharedCache = new Map<string, SurfaceAuditAdvice>();

function remember(cache: Map<string, SurfaceAuditAdvice>, key: string, advice: SurfaceAuditAdvice): void {
  if (cache.size >= MAX_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, advice);
}

/** The cached advice for this mission and merged set, if any. Lets a caller skip the diff read behind the facts. */
export function cachedSurfaceAuditAdvice(missionId: string, prNumbers: readonly number[], cache: Map<string, SurfaceAuditAdvice> = sharedCache): SurfaceAuditAdvice | null {
  return cache.get(adviceCacheKey(missionId, prNumbers)) ?? null;
}

/**
 * Ask for a recommendation. Never throws; null means "no recommendation".
 * Spends only on a cache miss, and logs ids, labels and numbers only.
 */
export async function adviseSurfaceAudit(input: AdviceInput, deps: AdviceDeps = {}): Promise<SurfaceAuditAdvice | null> {
  const log = deps.log ?? ((line: string) => console.log(line));
  const cache = deps.cache ?? sharedCache;
  try {
    if (input.uiPaths.length === 0) return null;
    if (input.dataClass === 'sensitive') return null;

    const key = adviceCacheKey(input.missionId, input.prNumbers);
    const hit = cache.get(key);
    if (hit) return hit;

    const client = deps.decide && deps.resolveAccess ? null : await import('@buildd/core/decision-client');
    const resolveAccess = deps.resolveAccess ?? (client!.resolveDecisionAccess as ResolveAccess);
    const access = await resolveAccess({
      capability: SURFACE_AUDIT_ADVICE_CAPABILITY,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      userId: input.userId ?? null,
    });
    if (!access.ok) return null;

    const scope = { teamId: input.teamId, accountId: input.accountId ?? null };
    const recordReceipt = deps.recordReceipt ?? (async (receipt, s) => {
      const { insertDecisionReceipts } = await import('./memory-decisions');
      await insertDecisionReceipts([receipt], s);
    });
    const receipts: Promise<void>[] = [];
    const decide = deps.decide ?? (client!.decisionCall as DecideFn);
    const res: DecisionResult<Questions> = await decide({
      capability: SURFACE_AUDIT_ADVICE_CAPABILITY,
      teamId: input.teamId,
      workspaceId: input.workspaceId,
      accountId: input.accountId ?? null,
      userId: input.userId ?? null,
      state: buildAdviceState(input),
      questions: { pick: SURFACE_AUDIT_ADVICE_QUESTION },
      timeoutMs: ADVICE_TIMEOUT_MS,
      decisionId: SURFACE_AUDIT_ADVICE_DECISION_ID,
      access,
      onUsage: receipt => { receipts.push(recordReceipt(receipt, scope).catch(() => {})); },
    });
    await Promise.all(receipts);

    if (!res.ok) {
      log(`${SURFACE_AUDIT_ADVICE_LOG_PREFIX} ${JSON.stringify({ mission: input.missionId.slice(0, 8), error: res.error.kind, latencyMs: res.latencyMs })}`);
      return null;
    }
    const { choice, confidence } = res.answers.pick;
    log(`${SURFACE_AUDIT_ADVICE_LOG_PREFIX} ${JSON.stringify({
      v: `${SURFACE_AUDIT_ADVICE_PROMPT_VERSION}|${res.model}`,
      mission: input.missionId.slice(0, 8),
      pick: choice,
      confidence,
      shown: confidence >= ADVICE_MIN_CONFIDENCE,
      latencyMs: res.latencyMs,
      inputTokens: res.usage?.inputTokens ?? null,
      costUsd: res.usage?.costUsd ?? null,
    })}`);
    if (confidence < ADVICE_MIN_CONFIDENCE) return null;
    if (choice !== 'audit' && choice !== 'waive') return null;

    const advice = composeAdvice(choice, input);
    remember(cache, key, advice);
    return advice;
  } catch (err) {
    console.error(`${SURFACE_AUDIT_ADVICE_LOG_PREFIX} failed (non-fatal, sheet shows both actions):`, err);
    return null;
  }
}
