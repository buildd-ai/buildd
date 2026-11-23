'use client';

/**
 * `?state=connect-repo`: the page a T3 thread on `buildd acp` links to when
 * its project matched no workspace the runner reaches
 * (app/(protected)/connect-repo). Fake cases, nothing is posted: one workspace
 * to pick, a create with two teams and a long repo name that has to wrap at
 * 320px, and the done state.
 */
import ConnectRepoView from '../../(protected)/connect-repo/ConnectRepoView';

const RUNNER = 'fixture-runner';
const LONG_REPO = 'acme-platform/customer-notifications-and-billing-reconciliation-service';

export default function ConnectRepoFixture() {
  return (
    <div className="min-h-screen bg-surface-1 divide-y divide-border-default">
      <ConnectRepoView
        repo="acme/app" runnerId={RUNNER} token="fixture" action="#"
        found={{ kind: 'pick', runnerName: 'Laptop', workspaces: [{ id: 'ws-1', name: 'app', teamId: 't-1', teamName: 'Acme Platform' }] }}
      />
      <ConnectRepoView
        repo={LONG_REPO} runnerId={RUNNER} token="fixture" action="#"
        error="The buildd GitHub App cannot see this repo. Add the repo to the App's access on GitHub, then reload this page."
        found={{ kind: 'create', runnerName: 'Laptop', teams: [{ id: 't-1', name: 'Acme Platform' }, { id: 't-2', name: 'Personal' }] }}
      />
      <ConnectRepoView
        repo="acme/app" runnerId={RUNNER} token="fixture" action="#" created
        found={{ kind: 'already', runnerName: 'Laptop', workspace: { id: 'ws-1', name: 'app', teamId: 't-1', teamName: 'Acme Platform' } }}
      />
    </div>
  );
}
