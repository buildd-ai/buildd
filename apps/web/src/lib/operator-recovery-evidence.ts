/**
 * The evidence pack a model sees about a failure cause (operator-recovery
 * spec §6.3), and the ref map that turns its `ev<n>` ids back into real refs.
 *
 * What goes in: family and cause codes, counts and timings, error-family
 * slugs, state transitions, repairs tried, evidence ids, and at most four
 * excerpts of at most 400 characters. What never goes in: a team, workspace,
 * repo, user or task name, a row id, a URL or a secret.
 *
 *  - Names the caller knows about are replaced by pseudonyms (`team-1`,
 *    `ws-2`, `repo-1`, `user-1`, `task-3`) before anything else runs.
 *  - Excerpts then go through `redactLogText` (secrets, UUIDs, tenancy
 *    counts) and lose their URLs. (`redactArtifactText` in `@buildd/core`
 *    rewrites stored artifact bodies; text bound for a provider is redacted in
 *    memory here instead, never written back.)
 *  - Each excerpt is framed as untrusted data: the model is told it may carry
 *    instructions and not to follow them, and only the closed `answer` of its
 *    reply is ever read.
 *
 * Pure.
 */
import {
  MAX_EXCERPT_CHARS, MAX_PACK_EVIDENCE, MAX_PACK_EXCERPTS, UNTRUSTED_EXCERPT_NOTE,
  type OperatorEvidencePack, type OperatorPackCause, type OperatorPackEvidence, type OperatorPackExcerpt,
} from '@buildd/core/decision-kind-operator-recovery';
import type { FailureIncident, FailureRecoveryAttempt } from '@buildd/shared';
import { causeCodeOf, causeDiscriminator, causeScope } from './failure-incident-cause-key';
import { redactLogText } from './ci-failure-excerpts';

/** §6.4: input tokens per call. Excerpts are dropped first; a pack still over it is not sent. */
export const MAX_INPUT_TOKENS = 6_000;
/** Question text and framing the kind adds around the pack. */
const PROMPT_OVERHEAD_TOKENS = 700;
const MAX_ATTEMPT_EVIDENCE = 6;

export type PackIncident = Pick<FailureIncident, 'id' | 'rule' | 'reasonCode' | 'signature' | 'workspaceId' | 'severity' | 'status' | 'firstSeenAt' | 'impact' | 'recovery'>;

export interface PackCauseInput {
  causeKey: string;
  members: readonly PackIncident[];
  tier: number | null;
  state: string;
  counts: {
    teams: number; workspaces: number; missions: number; tasks: number;
    blockedNow: number; episodes24h: number; reopens7d: number;
  };
  oldestOpenAgeH: number;
  lastProgressAt: string | null;
  /** The cause's attempt events, newest last. */
  attempts: ReadonlyArray<{ actionKey: string; capability: string; outcome: string }>;
  /** Raw text the caller read (a worker error, an evidence note), newest first. Redacted here. */
  excerpts?: ReadonlyArray<{ ref: string; text: string }>;
}

/** Every tenant name the caller can see, by category. Each is replaced before any other redaction. */
export interface PackNames {
  teams?: readonly string[];
  workspaces?: readonly string[];
  repos?: readonly string[];
  users?: readonly string[];
  tasks?: readonly string[];
}

export interface BuiltEvidencePack {
  pack: OperatorEvidencePack;
  /** `ev<n>` → the real ref (`incident:<id>`, `attempt:<actionKey>`, the excerpt's own ref). Never sent. */
  refs: Map<string, string>;
  /** Rough input tokens of the pack plus the question. */
  tokens: number;
  /** Excerpts dropped to fit `MAX_INPUT_TOKENS`. */
  droppedExcerpts: number;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The pseudonym replacer: longest names first, so `acme-web` is not half-replaced by `acme`. */
export function pseudonymiser(names: PackNames): (text: string) => string {
  const pairs: Array<[string, string]> = [];
  const add = (list: readonly string[] | undefined, prefix: string) => {
    const seen = new Map<string, string>();
    for (const raw of list ?? []) {
      const name = raw.trim();
      if (name.length < 3 || seen.has(name.toLowerCase())) continue;
      const alias = `${prefix}-${seen.size + 1}`;
      seen.set(name.toLowerCase(), alias);
      pairs.push([name, alias]);
    }
  };
  add(names.teams, 'team');
  add(names.workspaces, 'ws');
  add(names.users, 'user');
  add(names.tasks, 'task');
  // A repo is `owner/name`: the whole, then each half (an owner is often a person's handle).
  const repos = names.repos ?? [];
  add(repos, 'repo');
  add(repos.flatMap(r => r.split('/')).filter(Boolean), 'org');
  pairs.sort((a, b) => b[0].length - a[0].length);
  const res = pairs.map(([name, alias]) => [new RegExp(`(?<![A-Za-z0-9])${escapeRe(name)}(?![A-Za-z0-9])`, 'gi'), alias] as const);
  return text => res.reduce((t, [re, alias]) => t.replace(re, alias), text);
}

const URL_RE = /\b(?:https?:\/\/|www\.)\S+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/** One excerpt, ready to send: pseudonymised, redacted, URL- and email-free, bounded. */
export function redactExcerpt(text: string, pseudonymise: (t: string) => string): string {
  const out = redactLogText(pseudonymise(text)).replace(URL_RE, '[url]').replace(EMAIL_RE, '[email]').replace(/\s+/g, ' ').trim();
  return out.length > MAX_EXCERPT_CHARS ? `${out.slice(0, MAX_EXCERPT_CHARS - 1)}…` : out;
}

/** A slug the pack accepts: ids become pseudonyms, the rest is folded to `[a-z0-9_.:=|-]`. */
function packSlug(raw: string, alias: (kind: string, id: string) => string): string {
  const out = raw
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, m => alias('id', m))
    .replace(/\bpr:(\d+)\b/gi, (_m, n: string) => alias('pr', n))
    .toLowerCase()
    .replace(/[^a-z0-9_.:=|-]+/g, '_')
    .replace(/^[^a-z0-9]+/, '')
    .slice(0, 80);
  return out || '-';
}

const hoursBetween = (from: string | null, to: string) => (from ? Math.max(0, (Date.parse(to) - Date.parse(from)) / 3_600_000) : null);

/** Rough tokens: four characters each. */
export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 4) + PROMPT_OVERHEAD_TOKENS;

/**
 * Build the pack for one cause (repair, priority) or a pair (merge).
 * Deterministic: the same causes, names and clock give the same pack.
 */
export function buildOperatorEvidencePack(causes: readonly PackCauseInput[], ctx: { names: PackNames; now: string }): BuiltEvidencePack {
  const pseudonymise = pseudonymiser(ctx.names);
  const aliases = new Map<string, string>();
  const alias = (kind: string, id: string) => {
    const k = `${kind}:${id}`;
    if (!aliases.has(k)) aliases.set(k, `${kind}-${[...aliases.keys()].filter(x => x.startsWith(`${kind}:`)).length + 1}`);
    return aliases.get(k)!;
  };

  const refs = new Map<string, string>();
  const evidence: OperatorPackEvidence[] = [];
  const excerptCandidates: Array<{ id: string; text: string }> = [];
  const nextId = () => `ev${evidence.length + 1}`;
  const push = (e: Omit<OperatorPackEvidence, 'id'>, ref: string): string | null => {
    if (evidence.length >= MAX_PACK_EVIDENCE) return null;
    const id = nextId();
    evidence.push({ id, ...e, label: packSlug(e.label, alias).replace(/_/g, ' ').slice(0, 120) });
    refs.set(id, ref);
    return id;
  };

  const packCauses: OperatorPackCause[] = causes.map((c, i) => {
    const ref = `cause-${i + 1}`;
    const lead = c.members[0];
    const errorFamilies = [...new Set(c.members
      .filter(m => m.rule === 'repeated_failure' || m.rule === 'failure_rate_spike')
      .map(m => packSlug(causeDiscriminator(m.rule, m.signature, m.impact), alias)))];
    const tried: string[] = [];
    const attempts: FailureRecoveryAttempt[] = c.members.flatMap(m => m.recovery?.attempts ?? []);
    for (const a of attempts) tried.push(packSlug(a.action, alias));
    for (const m of c.members) push({ kind: 'incident', cause: ref, label: `incident ${m.rule} ${m.severity} ${m.recovery?.state ?? 'observing'}` }, `incident:${m.id}`);
    for (const a of c.attempts.slice(-MAX_ATTEMPT_EVIDENCE)) push({ kind: 'attempt', cause: ref, label: `attempt ${a.capability} ${a.outcome}` }, `attempt:${a.actionKey}`);
    for (const x of c.excerpts ?? []) {
      if (excerptCandidates.length >= MAX_PACK_EXCERPTS) break;
      const text = redactExcerpt(x.text, pseudonymise);
      if (!text) continue;
      const id = push({ kind: 'excerpt', cause: ref, label: 'excerpt' }, x.ref);
      if (id) excerptCandidates.push({ id, text });
    }
    return {
      ref,
      family: lead ? lead.rule : 'unknown',
      causeCode: lead ? packSlug(causeCodeOf(lead), alias) : 'unknown',
      scope: lead && causeScope(lead) !== 'platform' ? 'workspace' : 'platform',
      discriminator: lead ? packSlug(causeDiscriminator(lead.rule, lead.signature, lead.impact), alias) : '-',
      state: packSlug(c.state, alias),
      tier: c.tier === 0 || c.tier === 1 || c.tier === 2 || c.tier === 3 ? c.tier : null,
      counts: {
        incidents: c.members.length, teams: c.counts.teams, workspaces: c.counts.workspaces, missions: c.counts.missions, tasks: c.counts.tasks,
        blockedNow: c.counts.blockedNow, episodes24h: c.counts.episodes24h, reopens7d: c.counts.reopens7d,
        attempts: c.attempts.length,
        attemptsFailed: c.attempts.filter(a => a.outcome === 'failed' || a.outcome === 'rejected').length,
        attemptsNoEffect: c.attempts.filter(a => a.outcome === 'no_effect').length,
      },
      timings: { oldestOpenAgeH: Math.max(0, c.oldestOpenAgeH), sinceLastProgressH: hoursBetween(c.lastProgressAt, ctx.now) },
      errorFamilies,
      transitions: c.members.map(m => packSlug(m.recovery?.state ?? 'observing', alias)),
      tried: [...new Set(tried)],
    };
  });

  const excerpts: OperatorPackExcerpt[] = excerptCandidates.map(x => ({ id: x.id, untrusted: true, note: UNTRUSTED_EXCERPT_NOTE, text: x.text }));
  const pack: OperatorEvidencePack = { v: 1, causes: packCauses, evidence, excerpts };
  // §6.4: over the input budget, drop excerpts (newest kept) before anything else.
  let dropped = 0;
  while (pack.excerpts.length && estimateTokens(pack) > MAX_INPUT_TOKENS) {
    const gone = pack.excerpts.pop()!;
    pack.evidence = pack.evidence.filter(e => e.id !== gone.id);
    refs.delete(gone.id);
    dropped++;
  }
  return { pack, refs, tokens: estimateTokens(pack), droppedExcerpts: dropped };
}
