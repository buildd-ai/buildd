'use client';

import { useState } from 'react';
import EditTaskModal from './EditTaskModal';

interface Props {
  task: {
    id: string;
    title: string;
    description: string | null;
    priority: number;
    project?: string | null;
    workspaceId?: string;
  };
}

export default function EditTaskButton({ task }: Props) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="px-4 py-2 text-sm border border-border-default rounded-md hover:bg-surface-3"
      >
        Edit
      </button>

      {showModal && (
        <EditTaskModal task={task} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
