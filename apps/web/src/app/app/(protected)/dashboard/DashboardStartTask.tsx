'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import StartTaskModal from '../tasks/StartTaskModal';

interface Props {
  workspaces: { id: string; name: string }[];
}

export default function DashboardStartTask({ workspaces }: Props) {
  const [open, setOpen] = useState(false);
  const router = useRouter();

  if (workspaces.length === 0) return null;

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="w-full sm:w-auto px-[18px] py-[9px] rounded-[6px] text-[13px] font-medium bg-status-success text-white hover:bg-status-success/90"
      >
        Start Task
      </button>
      {open && (
        <StartTaskModal
          workspaces={workspaces}
          onClose={() => setOpen(false)}
          onCreated={(taskId) => {
            setOpen(false);
            router.push(`/app/tasks/${taskId}`);
          }}
        />
      )}
    </>
  );
}
