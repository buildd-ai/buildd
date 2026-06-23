'use client';

import { Suspense, useState, useCallback, useEffect } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import TaskPanel from './TaskPanel';

const FULL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Zero-padded IDs like "bf442fcb-0000-0000-0000-000000000000" are the known regression
// pattern: only the first 8 hex chars are real, the rest were zero-filled.
const ZERO_PADDED_RE = /^[0-9a-f]{8}-0{4}-0{4}-0{4}-0{12}$/i;

function isValidTaskId(id: string | null | undefined): id is string {
  if (!id) return false;
  if (!FULL_UUID_RE.test(id)) {
    console.warn('[TaskPanel] Malformed task ID rejected (bad format):', id);
    return false;
  }
  if (ZERO_PADDED_RE.test(id)) {
    console.warn('[TaskPanel] Malformed task ID rejected (zero-padded short ID):', id);
    return false;
  }
  return true;
}

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

  // Intercept clicks on task links (data-task-id attribute)
  const handleClick = useCallback((e: React.MouseEvent) => {
    const target = (e.target as HTMLElement).closest('[data-task-id]');
    if (!target) return;

    const id = target.getAttribute('data-task-id');
    if (!isValidTaskId(id)) return;

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
