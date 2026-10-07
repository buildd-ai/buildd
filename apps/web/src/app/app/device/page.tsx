import { redirect } from 'next/navigation';
import { auth } from '@/auth';
import { lookupDeviceCodeForConfirm, type DeviceConfirmLookup } from '@/lib/device-confirm';
import DeviceConfirm from './DeviceConfirm';

// Invariant: a device code is approved only by an explicit confirm.
// This page reads the code (pre-filled from ?code= or typed by the user) and
// shows what it would connect; it never approves. Approval is the
// "Approve device" button in DeviceConfirm, which POSTs with confirm: true.

const LOOKUP_ERRORS: Record<Exclude<DeviceConfirmLookup, { ok: true }>['reason'], string> = {
  not_found: 'That code was not found. Check the code in your terminal and try again.',
  expired: 'That code has expired. Run the login command again to get a new one.',
  already_used: 'That code has already been used. Run the login command again to get a new one.',
};

function signInRedirect(code: string | undefined): never {
  const back = code ? `/app/device?code=${encodeURIComponent(code)}` : '/app/device';
  redirect(`/app/auth/signin?callbackUrl=${encodeURIComponent(back)}`);
}

export default async function DevicePage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const params = await searchParams;
  const code = (Array.isArray(params.code) ? params.code[0] : params.code)?.trim() || undefined;

  const session = await auth();
  if (!session?.user?.id) signInRedirect(code);

  const lookup = code ? await lookupDeviceCodeForConfirm(code, session.user.id) : null;

  return (
    <main className="relative min-h-screen flex items-center justify-center p-6 overflow-hidden bg-surface-1">
      <div className="absolute inset-0 z-0">
        <picture>
          <source media="(min-width: 1024px)" srcSet="/hero/logo-desktop.webp" type="image/webp" />
          <source media="(min-width: 768px)" srcSet="/hero/logo-tablet.webp" type="image/webp" />
          <source srcSet="/hero/logo-mobile.webp" type="image/webp" />
          <img
            src="/hero/logo-desktop.png"
            alt=""
            className="w-full h-full object-cover scale-110 blur-sm opacity-40"
          />
        </picture>
        <div className="absolute inset-0 bg-surface-1/90" />
      </div>

      <div className="relative z-10 w-full max-w-md">
        <div className="backdrop-blur-xl bg-surface-2/80 border border-border-default rounded-2xl p-6 sm:p-8 shadow-2xl">
          <div className="text-center mb-8">
            <h1 className="text-4xl font-bold text-text-primary mb-2">buildd</h1>
            <p className="text-text-secondary">Authorize Device</p>
          </div>

          {lookup?.ok ? (
            <DeviceConfirm details={lookup.details} />
          ) : (
            // A plain GET form: entering a code only navigates to ?code=…,
            // which shows the confirm step above. It cannot approve anything.
            <form method="get" action="/app/device" data-testid="device-code-entry">
              <p className="text-text-secondary text-sm mb-4">
                Enter the code shown in your terminal to link this device.
              </p>

              {lookup && !lookup.ok && (
                <div className="mb-4 bg-status-error/10 border border-status-error/20 rounded-lg p-4 text-status-error text-sm">
                  {LOOKUP_ERRORS[lookup.reason]}
                </div>
              )}

              <input
                type="text"
                name="code"
                defaultValue={code ?? ''}
                placeholder="ABCD-1234"
                autoFocus
                required
                maxLength={9}
                autoCapitalize="characters"
                autoComplete="off"
                className="w-full px-4 py-3 bg-surface-1 border border-border-default rounded-lg text-text-primary text-center text-2xl font-mono tracking-widest uppercase placeholder:text-text-muted focus:outline-none focus:ring-2 focus:ring-primary-ring focus:border-primary"
              />

              <button
                type="submit"
                className="mt-4 w-full px-4 py-3 bg-primary text-white font-medium rounded-md hover:bg-primary-hover transition-colors shadow-lg"
              >
                Continue
              </button>
            </form>
          )}

          <p className="mt-6 text-center text-sm text-text-muted">
            Approve only codes you started from your own terminal.
          </p>
        </div>
      </div>
    </main>
  );
}
