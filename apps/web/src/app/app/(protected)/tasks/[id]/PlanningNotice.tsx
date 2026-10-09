import Notice from '@/components/ui/Notice';

/**
 * Where a planning-mode task stands, as the shared `Notice`: a planning task
 * has no Build → Audit → Land delivery (it ends in a plan for review, not a
 * PR), so this is a status line, not a `Lifecycle`. A finished plan awaiting
 * review renders nothing: `PlanReviewPanel` owns that state.
 */
export default function PlanningNotice({ subTaskCount, running, status }: { subTaskCount: number; running: boolean; status: string }) {
  if (subTaskCount > 0) {
    return (
      <Notice tone="ok" className="mb-6" title={`Plan approved · ${subTaskCount} child task${subTaskCount !== 1 ? 's' : ''} created`} />
    );
  }
  if (running) return <Notice tone="info" className="mb-6" title="The agent is writing a plan…" />;
  if (status === 'pending' || status === 'assigned') {
    return <Notice tone="info" className="mb-6" title="A planning agent will write a plan for your review" />;
  }
  return null;
}
