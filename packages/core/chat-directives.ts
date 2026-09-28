/**
 * Chat directives (docs/design/memory-done-right.md, "Chat" and Decision #3):
 * rules a person states in chat ("always ...", "never ...", "from now on ...")
 * that, once confirmed in one tap, load into every one of their chat turns.
 *
 * Pure. The Jev calls live in memory-decisions.ts (`judgeChatDirective`), the
 * storage in apps/web/src/lib/chat/directives-store.ts. This module holds the
 * parts that must agree everywhere: the deterministic rule that decides when
 * Jev is absent or unsure, the text a card proposes, and the block a turn loads.
 */
import { CHAT_TIER_MIN_CONFIDENCE, DIRECTIVE_SCOPE_MIN_CONFIDENCE, type DirectiveScope } from './memory-decisions';

/** Longest rule a person can save. A rule is a sentence, not a document. */
export const DIRECTIVE_TEXT_MAX = 280;
/** Stored rules per person. The turn loads far fewer (STANDING_RULES_MAX). */
export const MAX_DIRECTIVES_PER_USER = 50;
/** Rules one turn loads, newest first. */
export const STANDING_RULES_MAX = 12;
/** Character budget for the loaded rules (about 600 tokens at 4 chars a token). */
export const STANDING_RULES_CHAR_BUDGET = 2_400;

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * Words that start a standing rule. They only decide whether Jev is asked at
 * all, so an ordinary turn spends nothing.
 */
const STRONG_CUE_RE = /\b(always|never|remember|from now on|going forward|in (?:the )?future|don'?t ever|do not ever)\b/i;
/**
 * Weaker words ("I prefer", "make sure", "whenever") count only next to a
 * verb an agent would act on: "whenever you open a PR, run the tests" asks,
 * "I prefer mornings" does not.
 */
const WEAK_CUE_RE = /\b(prefer|make sure|whenever|every time|by default)\b/i;
const RULE_VERB_RE = /\b(use|open|run|write|keep|add|avoid|include|ask|check|test|name|squash|rebase|merge|commit|push|deploy|tag|label|mention|reply|respond|file|split|link|review)\b/i;

function cued(s: string): boolean {
  return STRONG_CUE_RE.test(s) || (WEAK_CUE_RE.test(s) && RULE_VERB_RE.test(s));
}

/**
 * The deterministic rule, used when Jev is unavailable or below its threshold:
 * a sentence that opens with a rule word, or says what agents / you / we
 * always or never do. A question is never a rule.
 */
const RULE_OPENERS = /^(?:(?:ok(?:ay)?|and|also|so|note)[,:]?\s+)?(?:please\s+)?(?:always|never|from now on|going forward|in (?:the )?future|remember(?:\s+(?:to|that))?\b|do not ever|don'?t ever)\b/i;
const RULE_SUBJECT = /\b(?:you|agents?|we|buildd)\s+(?:should\s+|must\s+|will\s+)?(?:always|never)\b/i;
const FROM_NOW_ON = /\b(?:from now on|going forward)\b/i;

function sentences(text: string): string[] {
  return text.split(SENTENCE_SPLIT).map(s => s.trim()).filter(Boolean);
}

/** Does this message carry a rule cue worth asking Jev about? */
export function mentionsRule(text: string | null | undefined): boolean {
  return !!text && sentences(text).some(cued);
}

function ruleSentence(s: string): boolean {
  if (s.endsWith('?')) return false;
  return RULE_OPENERS.test(s) || RULE_SUBJECT.test(s) || FROM_NOW_ON.test(s);
}

/** The keyword rule: true when some sentence of the message states a rule. */
export function keywordDirective(text: string | null | undefined): boolean {
  if (!text) return false;
  return sentences(text).some(ruleSentence);
}

/** Whitespace collapsed, trimmed, capped. Null when empty. */
export function normalizeDirectiveText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t) return null;
  return t.length > DIRECTIVE_TEXT_MAX ? `${t.slice(0, DIRECTIVE_TEXT_MAX - 1).trimEnd()}…` : t;
}

const capitalize = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** "remember to run the tests" → "Run the tests". "Please always ..." → "Always ...". */
function tidy(s: string): string {
  let t = s.trim().replace(/^(?:ok(?:ay)?|and|also|so|note)[,:]?\s+/i, '');
  t = t.replace(/^please\s+/i, '');
  t = t.replace(/^remember(?:\s+(?:to|that))?[\s,:]+/i, '');
  return capitalize(t.trim());
}

/**
 * The rule a card proposes: the sentences that carry it, tidied. Falls back
 * to the whole message when none does (Jev read a rule without a cue word).
 */
export function directiveText(message: string): string {
  const all = sentences(message);
  const picked = all.filter(ruleSentence);
  const chosen = picked.length > 0 ? picked : all.filter(s => cued(s) && !s.endsWith('?'));
  const text = (chosen.length > 0 ? chosen.slice(0, 2) : all).map(tidy).join(' ');
  return normalizeDirectiveText(text) ?? '';
}

/** Jev's two answers, as the decider hands them over. Null answer: none came back. */
export interface ChatDirectiveJudgement {
  tier: { choice: 'directive' | 'knowledge' | 'neither'; confidence: number } | null;
  scope: { choice: DirectiveScope; confidence: number } | null;
}

export interface DirectiveProposal {
  text: string;
  /** Preselected on the card. Everywhere unless Jev confidently read a workspace rule. */
  suggestedScope: DirectiveScope;
  /** Who decided a card was due: Jev, or the keyword rule. */
  source: 'jev' | 'rule';
}

/**
 * Should this user message get a confirm card, and what does it propose?
 * A confident Jev tier decides (directive: card; knowledge or neither: none).
 * Anything else fails open to the keyword rule.
 */
export function proposeDirective(input: {
  message: string;
  workspace: { id: string; name: string } | null;
  judgement: ChatDirectiveJudgement | null;
}): DirectiveProposal | null {
  const tier = input.judgement?.tier ?? null;
  const confident = !!tier && tier.confidence >= CHAT_TIER_MIN_CONFIDENCE;
  const due = confident ? tier!.choice === 'directive' : keywordDirective(input.message);
  if (!due) return null;
  const text = directiveText(input.message);
  if (!text) return null;
  const scope = input.judgement?.scope ?? null;
  const suggestedScope: DirectiveScope = input.workspace && scope && scope.confidence >= DIRECTIVE_SCOPE_MIN_CONFIDENCE && scope.choice === 'workspace'
    ? 'workspace'
    : 'everywhere';
  return { text, suggestedScope, source: confident ? 'jev' : 'rule' };
}

export interface StandingRule {
  text: string;
  workspaceId: string | null;
  createdAt: Date | string;
}

/**
 * The rules that apply to one turn: everywhere rules plus rules for the
 * turn's workspace, newest first. A workspace rule never loads elsewhere.
 */
export function rulesForTurn<R extends StandingRule>(rules: readonly R[], workspaceId: string | null): R[] {
  const ts = (r: R) => new Date(r.createdAt).getTime() || 0;
  return rules
    .filter(r => r.workspaceId === null || (workspaceId !== null && r.workspaceId === workspaceId))
    .slice()
    .sort((a, b) => ts(b) - ts(a));
}

/**
 * The block appended to a turn's instructions, or '' when there are none.
 * At most STANDING_RULES_MAX rules and STANDING_RULES_CHAR_BUDGET characters,
 * newest first; what did not fit is counted, not silently dropped.
 */
export function renderStandingRules(
  rules: readonly StandingRule[],
  opts: { workspaceId: string | null; max?: number; charBudget?: number },
): string {
  const applicable = rulesForTurn(rules, opts.workspaceId);
  if (applicable.length === 0) return '';
  const max = opts.max ?? STANDING_RULES_MAX;
  const budget = opts.charBudget ?? STANDING_RULES_CHAR_BUDGET;
  const lines: string[] = [];
  let used = 0;
  for (const r of applicable) {
    if (lines.length >= max) break;
    const text = normalizeDirectiveText(r.text);
    if (!text) continue;
    const line = `- ${text}${r.workspaceId ? ' (this workspace only)' : ''}`;
    if (used + line.length > budget && lines.length > 0) break;
    lines.push(line);
    used += line.length + 1;
  }
  const hidden = applicable.length - lines.length;
  const head = 'The user\'s standing rules. They saved these themselves; follow them in every reply and every draft you propose, unless one conflicts with the rules above. Newest first.';
  const tail = hidden > 0 ? `\n(${hidden} older ${hidden === 1 ? 'rule' : 'rules'} not shown. The user can see every rule in Settings.)` : '';
  return `${head}\n${lines.join('\n')}${tail}`;
}

/** The heading of the block a chat-filed task or mission carries; also its idempotency marker. */
export const TASK_RULES_HEADING = '### Standing rules (from chat)';

/**
 * The block appended to the description of a task or mission that chat files,
 * so the agent that runs it follows the requester's rules and a person reading
 * the task can see why. Same selection and caps as the chat load (everywhere
 * rules plus the task's workspace, never another workspace's). '' when none apply.
 */
export function renderStandingRulesForTask(
  rules: readonly StandingRule[],
  opts: { workspaceId: string | null; max?: number; charBudget?: number },
): string {
  const block = renderStandingRules(rules, opts);
  if (!block) return '';
  const body = block.split('\n').slice(1).join('\n');
  return `${TASK_RULES_HEADING}\nThe person who asked for this in chat saved these rules. Follow them unless this task says otherwise.\n${body}`;
}

/**
 * A line that opens a rules block: the heading, in any heading level or case,
 * with or without the "(from chat)" suffix. Matched loosely on purpose: a
 * look-alike must not survive to be read as the real thing.
 */
const RULES_HEADING_LINE = /^[ \t]*#{1,6}[ \t]*standing rules\b.*$/i;
/** The lines a rules block holds after its heading: the lead sentence, list items, the "not shown" line. */
const RULES_BODY_LINE = /^[ \t]*(?:-[ \t].*|\(\d+ older rules? not shown\..*\)|The person who asked for this in chat saved these rules\..*)?$/i;

/**
 * The description with every rules block removed. The description arrives
 * from the model, so a block already in it is never trusted: it could forge
 * rules, or stand in for the real ones to suppress them.
 */
export function stripStandingRules(description: string): string {
  const out: string[] = [];
  let inBlock = false;
  for (const line of description.split('\n')) {
    if (RULES_HEADING_LINE.test(line)) { inBlock = true; continue; }
    if (inBlock && RULES_BODY_LINE.test(line) && line.trim() !== '') continue;
    inBlock = false;
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The description with any model-supplied rules block stripped and the
 * server-rendered block appended. The appended block is the only one that
 * survives, whatever the description contained.
 */
export function withStandingRules(description: unknown, block: string): string | undefined {
  const raw = typeof description === 'string' ? description : undefined;
  const base = raw !== undefined && raw.split('\n').some(l => RULES_HEADING_LINE.test(l)) ? stripStandingRules(raw) : raw;
  if (!block) return base;
  return base && base.trim() ? `${base.trimEnd()}\n\n${block}` : block;
}
