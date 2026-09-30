/**
 * The daily proposal pass, planning half. Pure: clusters in, actions out. The
 * clusters come from one SQL GROUP BY over judged lessons (./store.ts); no
 * model call runs anywhere in this pass.
 */
import type { CauseLabel, FixClassLabel } from './vocab';

/** Clustering window. */
export const PROPOSAL_WINDOW_DAYS = 14;
/** A cluster is a pattern only with this many sessions ... */
export const PROPOSAL_MIN_SESSIONS = 3;
/** ... on at least this many distinct days. */
export const PROPOSAL_MIN_DAYS = 2;
/** At most this many proposals are filed per team per day. */
export const RETRO_MAX_PROPOSALS_PER_TEAM_DAY = 2;
/** A closed proposal's signature stays muted until its sessions reach this multiple. */
export const MUTE_EVIDENCE_MULTIPLE = 2;
/** Evidence refs carried on a proposal. */
export const PROPOSAL_MAX_REFS = 10;

export interface Cluster {
  signature: string;
  primaryCause: CauseLabel;
  fixClass: FixClassLabel;
  toolName: string | null;
  sessions: number;
  days: number;
  wastedTokens: number;
  satisfiedYes: number;
  satisfiedPartly: number;
  satisfiedNo: number;
  /** The workspace most of the cluster's conversations ran in; null = team-wide chats only. */
  workspaceId: string | null;
  lessonIds: string[];
  conversationIds: string[];
}

/** The newest proposal task already filed for a signature in the target workspace. */
export interface PriorFiling {
  taskId: string;
  open: boolean;
  /** Sessions the proposal carried when last filed or appended. */
  sessions: number;
}

export type ProposalAction =
  | { kind: 'file'; cluster: Cluster; refiledAfter?: PriorFiling }
  | { kind: 'append'; cluster: Cluster; prior: PriorFiling }
  | { kind: 'unchanged'; cluster: Cluster; prior: PriorFiling }
  | { kind: 'muted'; cluster: Cluster; prior: PriorFiling }
  | { kind: 'deferred'; cluster: Cluster }
  | { kind: 'no_workspace'; cluster: Cluster };

/** waste × frequency, weighted by the share of sessions that were not fully satisfied. */
export function clusterScore(c: Cluster): number {
  const unsatisfied = c.sessions > 0 ? (c.satisfiedPartly + c.satisfiedNo) / c.sessions : 0;
  return c.wastedTokens * (1 + unsatisfied);
}

/** Eligible clusters, best first. One bad afternoon is not a pattern. */
export function rankClusters(clusters: Cluster[]): Cluster[] {
  return clusters
    .filter(c => c.sessions >= PROPOSAL_MIN_SESSIONS && c.days >= PROPOSAL_MIN_DAYS)
    .sort((a, b) => clusterScore(b) - clusterScore(a) || a.signature.localeCompare(b.signature));
}

/**
 * What to do with each ranked cluster. An open proposal gets new evidence
 * appended (never a second task); a closed one stays muted until its evidence
 * doubles; new filings stop at the daily cap and the rest are deferred.
 */
export function planProposals(
  ranked: Cluster[],
  priors: Map<string, PriorFiling | null>,
  opts: { filedToday: number; cap?: number },
): ProposalAction[] {
  const cap = opts.cap ?? RETRO_MAX_PROPOSALS_PER_TEAM_DAY;
  let filed = opts.filedToday;
  const actions: ProposalAction[] = [];
  for (const cluster of ranked) {
    if (!cluster.workspaceId) { actions.push({ kind: 'no_workspace', cluster }); continue; }
    const prior = priors.get(cluster.signature) ?? null;
    if (prior?.open) {
      actions.push(cluster.sessions > prior.sessions ? { kind: 'append', cluster, prior } : { kind: 'unchanged', cluster, prior });
      continue;
    }
    if (prior && cluster.sessions < prior.sessions * MUTE_EVIDENCE_MULTIPLE) {
      actions.push({ kind: 'muted', cluster, prior });
      continue;
    }
    if (filed >= cap) { actions.push({ kind: 'deferred', cluster }); continue; }
    filed++;
    actions.push(prior ? { kind: 'file', cluster, refiledAfter: prior } : { kind: 'file', cluster });
  }
  return actions;
}

export function proposalTitle(c: Cluster): string {
  return `[chat-retro] ${c.primaryCause} via ${c.toolName ?? 'no tool'}: ${c.fixClass}`;
}

/** Labels, counts and refs only. The worker reads the windows through the team's own access. */
export function proposalDescription(c: Cluster, lessonsUrl: string): string {
  return [
    'The chat retro pass found a repeated pattern of wasted effort in this team\'s chat sessions.',
    'This task carries labels, counts and references only, never message text.',
    '',
    `- Signature: \`${c.signature}\``,
    `- Cause: ${c.primaryCause}; suggested fix class: ${c.fixClass}; tool: ${c.toolName ?? 'none'}`,
    `- Sessions affected: ${c.sessions} over ${c.days} days (last ${PROPOSAL_WINDOW_DAYS} days)`,
    `- Tokens wasted: ${c.wastedTokens}`,
    `- Satisfied: yes ${c.satisfiedYes}, partly ${c.satisfiedPartly}, no ${c.satisfiedNo}`,
    `- Lesson refs: ${c.lessonIds.slice(0, PROPOSAL_MAX_REFS).join(', ')}`,
    `- Conversation refs: ${c.conversationIds.slice(0, PROPOSAL_MAX_REFS).join(', ')}`,
    '',
    'To work it: read the referenced conversations you have access to, and write the proposed change',
    '(new description text, the missing parameter, the instruction, or the screen) with the sessions it',
    'would have changed. Do not change buildd automatically from this task: propose, and let a person decide.',
    'Closing this task without a fix mutes the signature until its evidence doubles.',
    '',
    `Recent lessons: ${lessonsUrl}`,
  ].join('\n');
}

export function appendText(c: Cluster, prior: PriorFiling, now: Date): string {
  return `\n\n---\n_Chat retro, ${now.toISOString().slice(0, 10)}: now ${c.sessions} sessions (was ${prior.sessions}), ${c.wastedTokens} tokens wasted. Lesson refs: ${c.lessonIds.slice(0, PROPOSAL_MAX_REFS).join(', ')}_`;
}
