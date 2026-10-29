/**
 * THE build-complete predicate (Navigation d25d923d R-15): every build task
 * has landed, and there is at least one. The Overview's stages, `explain`'s
 * open checks and the mission card all ask this one function, so a mission
 * cannot read Verify on one surface and Build on another. A reopened task (a
 * merged attempt followed by a newer one that has not landed) lowers `done`,
 * so the Build stage returns by itself.
 */
export function isBuildComplete(build: { done: number; total: number }): boolean {
  return build.total > 0 && build.done >= build.total;
}
