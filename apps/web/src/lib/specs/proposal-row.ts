/** A listed proposal (./proposals.ts), a pure shape the page and its component share. */
export interface ProposalRow {
  specId: string;
  title: string;
  workspaceId: string;
  headRevision: number;
  proposedAt: string;
  /** The task that wrote it, when it still exists. */
  taskId: string | null;
  taskTitle: string | null;
}
