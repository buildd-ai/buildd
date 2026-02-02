'use client';

import { useState } from 'react';
import EditTaskModal from './EditTaskModal';

interface Props {
  task: {
    id: string;
    title: string;
    description: string | null;
    priority: number;
  };
}

export default function EditTaskButton({ task }: Props) {
  const [showModal, setShowModal] = useState(false);

  return (
    <>
      <button
        onClick={() => setShowModal(true)}
        className="px-4 py-2 text-sm border border-gray-300 dark:border-gray-700 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-800"
      >
        Edit
      </button>

      {showModal && (
        <EditTaskModal task={task} onClose={() => setShowModal(false)} />
      )}
    </>
  );
}
