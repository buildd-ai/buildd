/** A fix that turns CI red is not a fix: targeted tests alone never show a type or build break. */
export const VERIFY_BEFORE_PUSH =
  "Before you push, run the repo's type check (`bun run type-check`, or `tsc --noEmit` in each package you touched) and the build step for anything you changed, not only the targeted tests. If either fails, fix it first; never push a head that breaks the type check or the build.";
