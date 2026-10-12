/**
 * @buildd/spec-contract: Living Specs' portable contract (docs/specs/living-specs.md,
 * "Portable contract"). The shapes and the pure rules a product needs to keep
 * specs, pin work to them and grade work against them, with nothing of buildd's
 * store, kernel, runner or auth. A product that copies Living Specs copies
 * this package; buildd reads these rules from here too.
 */
export * from './requirements';
export * from './check-lines';
export * from './scope';
export * from './outcome';
export * from './hash';
export * from './shapes';
export * from './source';
export * from './confluence-markdown';
export * from './confluence';
