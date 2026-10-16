/**
 * Role-slug gate for the claim route. The implementation lives in core
 * (lib/claim-order.ts) so the runner queue read applies the very same
 * predicate (spec c7410e76 R-26) without a core import of this module.
 */
export { isRoleClaimable, roleSlugGate } from '@/lib/claim-order';
