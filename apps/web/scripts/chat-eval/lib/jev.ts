/**
 * Jev (decision calls) for the eval: classify questions the way chat's router
 * does, and judge answers. The only non-OAuth spend in the harness, and a
 * small one: one OpenRouter decision call per question per step.
 *
 * Key: OPENROUTER_API_KEY, else the team's decision key resolved from the DB
 * for the team owning the buildd key's workspaces (needs DATABASE_URL; run with
 * apps/web/.env.local loaded). Never printed.
 */
import { decisionCall, type ChoiceQuestion } from '@buildd/core/decision-client';
import { CHAT_ROUTING_QUESTIONS, routeTurn, type TurnRoute } from '../../../src/lib/chat/routing';
import { callRemoteTool } from './remote';

let cached: string | null = null;

export async function jevKey(): Promise<string> {
  if (cached) return cached;
  if (process.env.OPENROUTER_API_KEY) return (cached = process.env.OPENROUTER_API_KEY);
  if (!process.env.DATABASE_URL) throw new Error('Jev needs OPENROUTER_API_KEY, or DATABASE_URL to resolve the team decision key (load apps/web/.env.local)');
  // The team that owns the workspaces this buildd key reaches.
  const { db } = await import('@buildd/core/db');
  const { workspaces } = await import('@buildd/core/db/schema');
  const { inArray } = await import('drizzle-orm');
  const { resolveDecisionKey } = await import('@buildd/core/decision-client');
  const listed = await callRemoteTool('buildd', { action: 'manage_workspaces', params: { action: 'list' } });
  const ids = [...listed.text.matchAll(/ID: ([0-9a-f-]{36})/g)].map(m => m[1]);
  const rows = await db.select({ id: workspaces.id, teamId: workspaces.teamId }).from(workspaces).where(inArray(workspaces.id, ids));
  // Then the team chat itself runs in (its conversations), which is where
  // chat's router spends: the key's workspaces may sit in another team.
  const { conversations } = await import('@buildd/core/db/schema');
  const chatTeams = (await db.selectDistinct({ teamId: conversations.teamId }).from(conversations)).map(r => r.teamId);
  const teams = process.env.CHAT_EVAL_TEAM_ID ? [process.env.CHAT_EVAL_TEAM_ID] : [...new Set([...rows.map(r => r.teamId), ...chatTeams])];
  let decisionKey: string | null = null;
  for (const teamId of teams) {
    decisionKey = await resolveDecisionKey({ teamId, workspaceId: rows.find(r => r.teamId === teamId)?.id });
    if (decisionKey) break;
  }
  if (!decisionKey) throw new Error('no decision key for any team the buildd key reaches; set OPENROUTER_API_KEY or CHAT_EVAL_TEAM_ID');
  return (cached = decisionKey);
}

export interface Classification {
  complexity: string; intent: string; area: string;
  confidence: { complexity: number; intent: number; area: number };
  /** What chat's router does with these answers (gates applied). */
  route: TurnRoute;
}

/**
 * The eval's routing deadline. Generous, so a classification is about the
 * questions rather than the network; `--timeout 900` observes production's
 * (`ROUTING_TIMEOUT_MS`), where a slow call is a fallback turn.
 */
export const EVAL_ROUTING_TIMEOUT_MS = 8_000;

/**
 * Chat's own router, on the eval's key, at `timeoutMs`. Same questions, same
 * gates. `route` is what chat would do with the turn even when the call
 * failed (then `classification` is null and `route.routing` says why).
 */
export async function routeForEval(message: string, timeoutMs = EVAL_ROUTING_TIMEOUT_MS): Promise<{ classification: Classification | null; route: TurnRoute }> {
  const apiKey = await jevKey();
  let raw: Record<string, { choice: string; confidence: number }> | null = null;
  const route = await routeTurn(
    { teamId: 'eval', workspaceId: null, userId: 'eval', message },
    { decide: async p => {
      // Production's deadline also covers the policy check and key lookup;
      // the eval passes its key, so the whole budget is the provider's.
      const r = await decisionCall({ ...p, apiKey, timeoutMs });
      if (r.ok) raw = r.answers as never;
      return r;
    } },
  );
  if (!raw) return { classification: null, route };
  const a = raw as Record<string, { choice: string; confidence: number }>;
  return {
    classification: {
      complexity: a.complexity.choice, intent: a.intent.choice, area: a.area.choice,
      confidence: { complexity: a.complexity.confidence, intent: a.intent.confidence, area: a.area.confidence },
      route,
    },
    route,
  };
}

export async function classify(message: string, timeoutMs?: number): Promise<Classification | null> {
  return (await routeForEval(message, timeoutMs)).classification;
}

export const JUDGE_QUESTIONS = {
  answered: {
    type: 'choice',
    instructions: {
      question: 'Did `answer` do what the user asked in `question`?',
      rule: 'Judge against the question only. For a request to change something, proposing the change (a write in `proposed_writes`) counts as done. Follow the definitions.',
    },
    criteria: {
      full: 'Answers the question or carries out the request completely, from what the tools returned.',
      partial: 'Addresses part of it, or answers with a vaguer or incomplete version than the tools allowed.',
      no: 'Does not answer, answers something else, or asks for information it could have looked up.',
      declined_correctly: 'Correctly says buildd cannot do this (e.g. read code, handle secrets) and offers the right alternative.',
      clarified_correctly: 'Asks one needed question: the message points at something not in view ("this", "it", "the last run"), or names something the tools show does not exist.',
    },
  } satisfies ChoiceQuestion<'full' | 'partial' | 'no' | 'declined_correctly' | 'clarified_correctly'>,
  efficiency: {
    type: 'choice',
    instructions: {
      question: 'How economical were the tool calls in `tool_calls` for answering `question`?',
      rule: 'Count calls and how much they returned (`chars`). A call whose output was not needed is waste.',
    },
    criteria: {
      minimal: 'Every call was needed; no repeats; outputs were about the size the answer needed.',
      some_waste: 'One unneeded, repeated or overly broad call, or one output far larger than needed.',
      wasteful: 'Several unneeded or repeated calls, hunting across tools or workspaces, or mostly irrelevant output.',
      no_tools_needed: 'The question needed no tools and none were called.',
    },
  } satisfies ChoiceQuestion<'minimal' | 'some_waste' | 'wasteful' | 'no_tools_needed'>,
  obstacle: {
    type: 'choice',
    instructions: {
      question: 'What most held back a short, correct answer?',
      rule: 'Pick the single biggest obstacle visible in `tool_calls` and `answer`.',
    },
    criteria: {
      none: 'Nothing: the right tool answered directly.',
      missing_tool: 'No tool answers this directly; the agent had to combine or approximate.',
      missing_data: 'The right tool exists but its output lacks a field or filter the question needs.',
      noisy_output: 'A tool returned far more than needed (long lists, full bodies) for a small answer.',
      wrong_tool_first: 'The agent tried the wrong tool or bad arguments before the right one (errors, retries).',
      ambiguity: 'The question was ambiguous (which workspace, which task) and needed a clarifying question.',
      model_error: 'The tools gave what was needed but the answer misread or ignored it.',
    },
  } satisfies ChoiceQuestion<'none' | 'missing_tool' | 'missing_data' | 'noisy_output' | 'wrong_tool_first' | 'ambiguity' | 'model_error'>,
};

export type Judgement = { [K in keyof typeof JUDGE_QUESTIONS]: { choice: string; confidence: number } } & { costUsd: number | null };

export async function judge(state: Record<string, unknown>): Promise<Judgement | { error: string }> {
  const apiKey = await jevKey();
  const r = await decisionCall({ capability: 'chat', teamId: 'eval', state, questions: JUDGE_QUESTIONS, apiKey, timeoutMs: 15_000 });
  if (!r.ok) return { error: JSON.stringify(r.error) };
  const a = r.answers as Record<string, { choice: string; confidence: number }>;
  return {
    answered: { choice: a.answered.choice, confidence: a.answered.confidence },
    efficiency: { choice: a.efficiency.choice, confidence: a.efficiency.confidence },
    obstacle: { choice: a.obstacle.choice, confidence: a.obstacle.confidence },
    costUsd: r.usage?.costUsd ?? null,
  };
}

export { CHAT_ROUTING_QUESTIONS };
