/**
 * Due-queue name shared by the credential-lease writer and the expiry guard.
 *
 * Lives in its own module so neither route imports the other: a typo here
 * would mean the guard watches an always-empty set and never alerts, which is
 * the silent-failure mode the floor tick exists to bound.
 */
export const LEASE_DUE_QUEUE = 'lease-expiry';
