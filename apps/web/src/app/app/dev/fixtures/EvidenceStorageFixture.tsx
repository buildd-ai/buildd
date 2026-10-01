'use client';

/**
 * `?state=evidence-storage`: Settings → Storage with fixture backends. The
 * real page starts collapsed and needs a configured bucket, so a route
 * screenshot never reaches an open row, the edit form or the add form.
 * Top: the list with a failing workspace backend open (status, last error,
 * lifecycle rule). Bottom: the team default being edited, and the add form.
 */
import SettingsPage from '../../(protected)/settings/_components/SettingsPage';
import StorageSection from '../../(protected)/settings/storage/StorageSection';
import type { StorageBackend } from '../../(protected)/settings/storage/_lib/storage-form';

const TEAM: StorageBackend = {
  id: 'fixture-team-default',
  workspaceId: null,
  provider: 's3',
  endpoint: null,
  region: 'us-east-1',
  bucket: 'example-team-evidence',
  prefix: 'evidence',
  forcePathStyle: false,
  sse: 'AES256',
  kmsKeyId: null,
  retentionDays: 30,
  maxBytesPerTask: 8 * 1024 * 1024,
  status: 'ok',
  lastVerifiedAt: '2026-09-30T09:00:00.000Z',
  lastError: null,
  hasCredential: true,
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-30T09:00:00.000Z',
};

const WORKSPACE: StorageBackend = {
  ...TEAM,
  id: 'fixture-workspace',
  workspaceId: 'ws-a',
  provider: 'r2',
  endpoint: 'https://example-account.r2.cloudflarestorage.com',
  region: 'auto',
  bucket: 'example-workspace-evidence',
  forcePathStyle: true,
  sse: 'none',
  retentionDays: 14,
  status: 'failing',
  lastError: 'PutObject failed: AccessDenied. The key needs write access to the prefix.',
};

const WORKSPACES = [
  { id: 'ws-a', name: 'Workspace A' },
  { id: 'ws-b', name: 'Workspace B' },
];

export default function EvidenceStorageFixture() {
  return (
    <div className="min-h-screen bg-surface-1">
      <SettingsPage title="Storage" description="Fixture: list with a failing backend open.">
        <StorageSection
          workspaces={WORKSPACES}
          fixture={{ backends: [TEAM, WORKSPACE], canManage: true, openId: WORKSPACE.id }}
        />
      </SettingsPage>
      <SettingsPage title="Storage: edit and add" description="Fixture: the team default being edited, and the add form.">
        <StorageSection
          workspaces={WORKSPACES}
          fixture={{ backends: [TEAM], canManage: true, openId: TEAM.id, editingId: TEAM.id, adding: true }}
        />
      </SettingsPage>
    </div>
  );
}
