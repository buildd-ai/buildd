'use client';

import { Suspense, useState, useCallback, useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import TaskPanel from './TaskPanel';

function TaskPanelInner({ children }: { children: React.ReactNode }) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const [taskId, setTaskId] = useState<string | null>(searchParams.get('task'));

  // Sync from URL
  useEffect(() => {
    setTaskId(searchParams.get('task'));
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

  // Intercept clicks on task links (data-task-id attribute)
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-task-id]');
    if (!target) return;

    const id = target.getAttribute('data-task-id');
    if (!id) return;

    e.preventDefault();
    e.stopPropagation();
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
