import type { ReactNode } from 'react';
import Notice from '@/components/ui/Notice';
import PrimaryAction from '@/components/ui/PrimaryAction';
import type { ConnectRepoCase } from '@/lib/connect-repo';

const FRAME = 'pt-[4.5rem] px-4 pb-24 md:px-8 md:pt-8 md:pb-10';
const RESEND = 'Send your message again in T3. Nothing needs restarting.';

export interface ConnectRepoViewProps {
  repo: string;
  runnerId: string;
  found: ConnectRepoCase;
  /** Form token from lib/connect-repo.ts createConnectToken. */
  token: string;
  /** Where the form posts (`/api/connect-repo`); a fixture passes '#'. */
  action: string;
  /** The last confirm's refusal, carried back on the redirect. */
  error?: string | null;
  /** The last confirm created the workspace. */
  created?: boolean;
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className={FRAME} data-testid="connect-repo">
      <div className="max-w-md space-y-6">
        <h1 className="text-xl font-semibold text-text-primary break-words">{title}</h1>
        {children}
      </div>
    </main>
  );
}

function Choice({ name, options }: { name: string; options: Array<{ value: string; label: string; detail?: string }> }) {
  if (options.length === 1) return <input type="hidden" name={name} value={options[0].value} />;
  return (
    <fieldset className="divide-y divide-border-default border-y border-border-default">
      {options.map((o, i) => (
        <label key={o.value} className="flex items-start gap-3 py-3 min-h-11 cursor-pointer">
          <input type="radio" name={name} value={o.value} defaultChecked={i === 0} className="mt-1" />
          <span className="min-w-0">
            <span className="block text-sm text-text-primary break-words">{o.label}</span>
            {o.detail && <span className="block text-xs text-text-muted break-words">{o.detail}</span>}
          </span>
        </label>
      ))}
    </fieldset>
  );
}

/**
 * The connect-repo page body (page.tsx reads the case; the dev fixture
 * passes one). One confirm button, or a notice saying why there is none.
 */
export default function ConnectRepoView({ repo, runnerId, found, token, action, error, created }: ConnectRepoViewProps) {
  const errorNotice = error ? <Notice tone="err" data-testid="connect-repo-error">{error}</Notice> : null;
  const hidden = (
    <>
      <input type="hidden" name="repo" value={repo} />
      <input type="hidden" name="runner" value={runnerId} />
      <input type="hidden" name="token" value={token} />
    </>
  );

  switch (found.kind) {
    case 'bad_request':
      return <Frame title="Connect a repo"><Notice tone="err" title="This link is not complete">{found.message}</Notice></Frame>;
    case 'key_not_found':
      return (
        <Frame title="Connect a repo">
          <Notice tone="err" title="Runner not found">
            This link names a runner you did not set up. Open the link from a T3 thread on your own runner.
          </Notice>
        </Frame>
      );
    case 'team_key':
      return (
        <Frame title="Connect a repo">
          <Notice tone="warn" title={`${found.runnerName} is ${found.teamName}'s runner`} data-testid="connect-repo-team-key">
            Its key only works in {found.teamName}&apos;s workspaces. Run <code>buildd login</code> on this machine to sign in as you, then open the link again.
          </Notice>
        </Frame>
      );
    case 'already':
      return (
        <Frame title={created ? `Connected ${repo}` : `${found.runnerName} can already work on ${repo}`}>
          <Notice tone="ok" title={created ? `Created ${found.workspace.name}` : 'Nothing to change'} data-testid="connect-repo-done">
            {found.runnerName} works on {found.workspace.name} in {found.workspace.teamName}. {RESEND}
          </Notice>
        </Frame>
      );
    case 'pick': {
      const one = found.workspaces.length === 1 ? found.workspaces[0] : null;
      return (
        <Frame title={`Let ${found.runnerName} work on ${one ? one.name : repo}`}>
          <p className="text-sm text-text-secondary">
            {one
              ? <>{one.name} in {one.teamName} is the buildd workspace for {repo}. {found.runnerName} is not picked for it yet.</>
              : <>More than one of your workspaces is for {repo}. Choose the one {found.runnerName} should work on.</>}
          </p>
          {errorNotice}
          <form method="post" action={action} className="space-y-4">
            {hidden}
            <Choice name="workspaceId" options={found.workspaces.map((w) => ({ value: w.id, label: w.name, detail: w.teamName }))} />
            <PrimaryAction type="submit" fullWidthOnMobile data-testid="connect-repo-confirm">
              {one ? `Let ${found.runnerName} work on ${one.name}` : `Let ${found.runnerName} work on it`}
            </PrimaryAction>
          </form>
          <p className="text-xs text-text-muted">Then {RESEND.charAt(0).toLowerCase() + RESEND.slice(1)} You can change this runner&apos;s workspaces in Settings › Apps signed in as you.</p>
        </Frame>
      );
    }
    case 'create': {
      const one = found.teams.length === 1 ? found.teams[0] : null;
      return (
        <Frame title={`Connect ${repo} to buildd`}>
          <p className="text-sm text-text-secondary">
            None of your teams has a workspace for {repo}.{' '}
            {one ? <>Create one in {one.name}</> : <>Choose a team for it</>} and let {found.runnerName} work on it.
          </p>
          {errorNotice}
          <form method="post" action={action} className="space-y-4">
            {hidden}
            <Choice name="teamId" options={found.teams.map((t) => ({ value: t.id, label: t.name }))} />
            <PrimaryAction type="submit" fullWidthOnMobile data-testid="connect-repo-confirm">
              Create the workspace
            </PrimaryAction>
          </form>
          <p className="text-xs text-text-muted">Then {RESEND.charAt(0).toLowerCase() + RESEND.slice(1)}</p>
        </Frame>
      );
    }
    case 'blocked':
      return (
        <Frame title={`Connect ${repo}`}>
          <Notice tone="warn" title="You cannot change this here">{found.message}</Notice>
        </Frame>
      );
    case 'install_github': {
      const back = `/app/connect-repo?repo=${encodeURIComponent(repo)}&runner=${encodeURIComponent(runnerId)}`;
      return (
        <Frame title={`Connect ${repo} to buildd`}>
          <Notice
            tone="warn"
            title={`The buildd GitHub App is not on ${repo.split('/')[0]}`}
            action={{ label: 'Install on GitHub', href: `/api/github/install?returnUrl=${encodeURIComponent(back)}` }}
          >
            buildd works on a repo through its GitHub App. Install it for {repo.split('/')[0]} in one of your teams, then come back to this page.
          </Notice>
        </Frame>
      );
    }
    case 'no_team':
      return (
        <Frame title={`Connect ${repo}`}>
          <Notice tone="warn" title="A team admin needs to connect it">
            Creating a workspace takes a team owner or admin. Ask one to connect {repo}, then open this link again to let {found.runnerName} work on it.
          </Notice>
        </Frame>
      );
  }
}
