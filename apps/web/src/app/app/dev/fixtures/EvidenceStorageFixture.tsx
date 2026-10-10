'use client';

/**
 * `?state=evidence-storage`: Settings → Storage with fixture backends. The
 * real page starts collapsed and needs a configured bucket, so a route
 * screenshot never reaches an open row, the edit form or the add form.
 * Sections, top to bottom: no backends; a team default plus a failing
 * workspace backend open (status, last error, lifecycle rule); a verify in
 * progress; a verify that failed; the team default being edited ("credential
 * set") with the add form open.
 */
import SettingsPage from '../../(protected)/settings/_components/SettingsPage';
import StorageSection from '../../(protected)/settings/integrations/StorageSection';
import type { StorageBackend } from '../../(protected)/settings/integrations/_lib/storage-form';

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
      <SettingsPage title="Storage: none yet" description="Fixture: no backends, so evidence goes to the managed bucket.">
        <StorageSection workspaces={WORKSPACES} fixture={{ backends: [], canManage: true }} />
      </SettingsPage>
      <SettingsPage title="Storage" description="Fixture: list with a failing backend open.">
        <StorageSection
          workspaces={WORKSPACES}
          fixture={{ backends: [TEAM, WORKSPACE], canManage: true, openId: WORKSPACE.id }}
        />
      </SettingsPage>
      <SettingsPage title="Storage: verifying" description="Fixture: a verify in progress on the team default.">
        <StorageSection
          workspaces={WORKSPACES}
          fixture={{ backends: [TEAM], canManage: true, openId: TEAM.id, busy: true }}
        />
      </SettingsPage>
      <SettingsPage title="Storage: verify failed" description="Fixture: the check just failed on a workspace backend.">
        <StorageSection
          workspaces={WORKSPACES}
          fixture={{
            backends: [WORKSPACE],
            canManage: true,
            openId: WORKSPACE.id,
            message: { type: 'error', text: `The check failed: ${WORKSPACE.lastError}`, backendId: WORKSPACE.id },
          }}
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
