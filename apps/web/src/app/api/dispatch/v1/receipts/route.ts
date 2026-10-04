/**
 * POST /api/dispatch/v1/receipts — Dispatch's delivery outcomes, batched:
 * `{receipts: Receipt[]}` → `{applied}`. One statement projects them onto
 * handed-off outbox rows (@buildd/core/dispatch-handoff applyReceiptsSql);
 * re-sending a batch is a no-op, and shadow rows are never changed.
 *
 * Signed with DISPATCH_CALLBACK_SECRET (lib/dispatch-callback-auth.ts).
 */
import { applyReceipts, isProjectableReceipt } from '@buildd/core/dispatch-handoff';
import { callbackError, callbackJson, verifyDispatchCallback } from '@/lib/dispatch-callback-auth';

/** Dispatch flushes at 25; this bounds one statement's input. */
const MAX_RECEIPTS_PER_BATCH = 500;

export async function POST(req: Request) {
  const auth = await verifyDispatchCallback(req);
  if (!auth.ok) return auth.response;
  const list = (auth.body as { receipts?: unknown } | null)?.receipts;
  if (!Array.isArray(list)) return callbackError(400, 'receipts must be an array');
  if (list.length > MAX_RECEIPTS_PER_BATCH) return callbackError(413, `at most ${MAX_RECEIPTS_PER_BATCH} receipts per batch`);
  const valid = list.filter(isProjectableReceipt);
  const applied = await applyReceipts(valid);
  console.log(JSON.stringify({ event: 'dispatch_receipts', received: list.length, invalid: list.length - valid.length, applied }));
  return callbackJson({ applied });
}
