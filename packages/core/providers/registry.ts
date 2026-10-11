/**
 * Provider registry, as buildd's server code imports it.
 *
 * The registry itself is `@builddai/ai-kit/models/provider-registry`: core
 * depends on ai-kit (never the reverse), and ai-kit's
 * `PROVIDER_KEY_CAPABILITIES` derives from the registry, so the pure module
 * has to live there. This file re-exports it and pins its string unions to
 * core's own types at compile time, so a purpose or tier provider added on one
 * side and not the other fails `tsc` instead of drifting.
 *
 * Pure: type imports only beyond the re-export. No DB, no runtime config.
 */
import type { SecretPurpose } from '../secrets/types';
import type { TierProvider } from '../model-tier-defaults';
import type { BackendId } from '../backend-policy';
import type {
  AgentBackendId,
  ModelCredentialPurpose,
  TierProviderId,
} from '@builddai/ai-kit/models/provider-registry';

export {
  BACKEND_SURFACE,
  CREDENTIAL_SCOPES,
  PROVIDER_IDS,
  PROVIDER_REGISTRY,
  SURFACES,
  TIER_PROVIDER_IDS,
  TIER_PROVIDER_OPTIONS,
  backendCredentialPurposes,
  chatKeyPurposes,
  isProviderId,
  providerDescriptor,
  providerForRoute,
  providerStorages,
  surfaceSupport,
  tierProviderSurfaces,
  tierUsedBy,
} from '@builddai/ai-kit/models/provider-registry';
export type {
  AgentBackendId,
  CredentialScope,
  CredentialShape,
  CredentialStorage,
  ModelCredentialPurpose,
  ProviderDescriptor,
  ProviderId,
  Surface,
  SurfaceSupport,
  TierProviderId,
  TierProviderOption,
  TierUsedBy,
} from '@builddai/ai-kit/models/provider-registry';

// ── Compile-time agreement with core's own unions ────────────────────────────

type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Assert<T extends true> = T;

/** Every model-credential purpose is a real `secrets.purpose`. */
export type _PurposesAreSecretPurposes = Assert<[ModelCredentialPurpose] extends [SecretPurpose] ? true : false>;
/** The registry's tier providers are exactly the tier registry's. */
export type _TierProvidersMatch = Assert<Equal<TierProviderId, TierProvider>>;
/** The registry's backends are exactly the failover registry's. */
export type _BackendsMatch = Assert<Equal<AgentBackendId, BackendId>>;
