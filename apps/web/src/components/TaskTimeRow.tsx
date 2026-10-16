import Disclosure from '@/components/ui/Disclosure';
import type { TimeRowView } from '@/lib/task-time-row';

export default function TaskTimeRow({ view }: { view: TimeRowView }) {
  return <div className="space-y-0.5">
    <div className={view.overUpper ? 'text-status-warning' : 'text-text-primary'}>{view.text}</div>
    {view.explanation && <div className="text-meta text-text-muted">{view.explanation}</div>}
    {view.breakdown && <Disclosure summary="Estimate breakdown">
      <div className="text-meta text-text-muted">{view.breakdown}</div>
    </Disclosure>}
  </div>;
}
