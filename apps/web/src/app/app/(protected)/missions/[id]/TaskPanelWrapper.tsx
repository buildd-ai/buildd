'use client';

import { Suspense, useState, useCallback, useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { isValidTaskId } from '@/lib/task-id';
import TaskPanel from './TaskPanel';

function TaskPanelInner({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const rawParam = searchParams.get('task');
  const [taskId, setTaskId] = useState<string | null>(isValidTaskId(rawParam) ? rawParam : null);

  // Sync from URL — reject malformed IDs so they can't silently 404
  useEffect(() => {
    const id = searchParams.get('task');
    setTaskId(isValidTaskId(id) ? id : null);
  }, [searchParams]);

  const openTask = useCallback((id: string) => {
    setTaskId(id);
    const params = new URLSearchParams(searchParams.toString());
    params.set('task', id);
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [router, pathname, searchParams]);

  const closeTask = useCallback(() => {
    setTaskId(null);
    const params = new URLSearchParams(searchParams.toString());
    params.delete('task');
    const qs = params.toString();
    router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
  }, [router, pathname, searchParams]);

  // Intercept clicks on task links (data-task-id attribute).
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-task-id]');
    if (!target) return;

    // The peek only earns its place when there's something to act on. Rows that
    // opt out (data-task-actionable="false" — e.g. a plain completed task with
    // no PR) fall through to the underlying <Link> and navigate to the full
    // page instead of opening an empty drawer. Absent attribute = actionable.
    if (target.getAttribute('data-task-actionable') === 'false') return;

    const id = target.getAttribute('data-task-id');
    e.preventDefault();
    e.stopPropagation();
    if (!isValidTaskId(id)) return;
    openTask(id);
  }, [openTask]);

  return (
    <div onClick={handleClick}>
      {children}
      {taskId && <TaskPanel taskId={taskId} onClose={closeTask} />}
    </div>
  );
}

export default function TaskPanelWrapper({ children }: { children: React.ReactNode }) {
  return (
    <Suspense>
      <TaskPanelInner>{children}</TaskPanelInner>
    </Suspense>
  );
}
