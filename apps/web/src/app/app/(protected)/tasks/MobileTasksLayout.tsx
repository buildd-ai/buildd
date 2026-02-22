'use client';

import { useState, useEffect, useCallback } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import StartTaskModal from './StartTaskModal';

interface Props {
  sidebar: React.ReactNode;
  workspaces: { id: string; name: string }[];
  children: React.ReactNode;
}

export default function MobileTasksLayout({ sidebar, workspaces, children }: Props) {
  const pathname = usePathname();
  // Auto-open sidebar on mobile when on the tasks index route (no task selected)
  const isIndexRoute = pathname === '/app/tasks';
  const [sidebarOpen, setSidebarOpen] = useState(isIndexRoute);
  const [modalOpen, setModalOpen] = useState(false);
  const router = useRouter();

  // Close sidebar on navigation (mobile) — but re-open if navigating back to index
  useEffect(() => {
    if (pathname === '/app/tasks') {
      setSidebarOpen(true);
    } else {
      setSidebarOpen(false);
    }
  }, [pathname]);

  // Close sidebar on escape key
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') setSidebarOpen(false);
  }, []);

  useEffect(() => {
    if (sidebarOpen) {
      document.addEventListener('keydown', handleKeyDown);
      return () => document.removeEventListener('keydown', handleKeyDown);
    }
  }, [sidebarOpen, handleKeyDown]);

  return (
    <div className="flex h-screen overflow-hidden">
      {/* Mobile header bar */}
      <div className="md:hidden fixed top-0 left-0 right-0 z-30 flex items-center gap-3 px-4 py-3 bg-surface-2 border-b border-border-default">
        <button
          onClick={() => setSidebarOpen(true)}
          className="p-1.5 -ml-1.5 text-text-secondary hover:bg-surface-3 rounded-lg"
          aria-label="Open sidebar"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-sm font-semibold truncate">Tasks</span>
        {workspaces.length > 0 && (
          <button
            onClick={() => setModalOpen(true)}
            className="ml-auto text-xs px-2.5 py-1.5 bg-status-success text-white rounded hover:bg-status-success/90 font-medium"
          >
            Start Task
          </button>
        )}
      </div>

      {/* Mobile overlay */}
      {sidebarOpen && (
        <div
          className="md:hidden fixed inset-0 z-40 bg-black/40"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar - hidden on mobile by default, overlay when open */}
      <div
        className={`
          fixed inset-y-0 left-0 z-50 w-64 transform transition-transform duration-200 ease-in-out
          md:relative md:translate-x-0 md:transition-none
          ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
      >
        {sidebar}
      </div>

      {/* Main content - add top padding on mobile for the header bar */}
      <main className="flex-1 overflow-auto pt-12 md:pt-0">
        {children}
      </main>

      {/* Start Task Modal */}
      {modalOpen && (
        <StartTaskModal
          workspaces={workspaces}
          onClose={() => setModalOpen(false)}
          onCreated={(taskId) => {
            setModalOpen(false);
            router.push(`/app/tasks/${taskId}`);
          }}
        />
      )}
    </div>
  );
}
