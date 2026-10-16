/**
 * `render_activity` (docs/specs/workflow-state-kernel.md §12.1): regenerate
 * a kernel-owned delivery's activity comment from its transition log, through
 * the `Notify` port. The render itself is the host's; the kernel's part is
 * who it is for and rule 3: a render can be overtaken while it writes, so if
 * the delivery's version moved on, one more render is owed (a follow-up of
 * the same transition, idempotent on its version).
 */
import type { EffectHandler, EffectHandlers } from '../effects';
import type { KernelPorts } from '../ports';
import { need } from './ports-of';

export function activityHandlers(ports: KernelPorts): EffectHandlers {
  const renderActivity: EffectHandler = async (e) => {
    const view = await ports.store.loadView({ deliveryId: e.deliveryId });
    const d = view.delivery;
    if (!d) return { outcome: 'skipped:no_delivery' };
    if (d.authority === 'legacy') return { outcome: 'skipped:legacy_owns' };
    if (!d.repoFullName || d.prNumber == null) return { outcome: 'skipped:no_pr' };
    const r = await need(ports, 'notify', e.kind).activity({ deliveryId: d.id, version: d.version, view });
    let outcome = r?.outcome ?? 'ok';

    // Rule 3: the version may have advanced while we wrote; owe one more render.
    const after = (await ports.store.loadView({ deliveryId: d.id })).delivery;
    if (after && after.version > d.version) {
      await ports.store.insertFollowupEffect({
        deliveryId: d.id, transitionId: e.transitionId, kind: 'render_activity',
        dedupeKey: `render:${d.id}:${after.version}`, payload: { version: after.version },
      });
      outcome += '+followup';
    }
    return { outcome };
  };
  return { render_activity: renderActivity };
}
