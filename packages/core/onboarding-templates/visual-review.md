---
name: visual-review
description: "Take phone- and desktop-width screenshots of this repo's UI and review them before calling UI work done. Use for any change that touches what a page renders."
<!-- keep-if: projectName -->
author: {{projectNameYaml}}
<!-- /keep-if -->
---

# Visual Review

Tests prove the code runs. They say nothing about whether the page reads right
at 390px. Look at it.

## When to use

- Any change to a page, component, layout or style.
- **Before calling UI work done.** Attach or describe what you saw. "Tests pass"
  is not a UI verdict.

## Recipe

1. Start the app:
<!-- keep-if: startCommand -->
   `{{startCommand}}`
<!-- /keep-if -->
<!-- keep-if: !startCommand -->
   TODO(owner): no start command detected. Add the command that serves the app locally.
<!-- /keep-if -->
<!-- keep-if: devAuthEnvVar -->
2. The app has a development sign-in bypass. Set `{{devAuthEnvVar}}` when you
   start it; never enable that bypass in a deployed environment.
<!-- /keep-if -->
<!-- keep-if: !devAuthEnvVar -->
2. TODO(owner): if pages sit behind a login, say how an agent signs in locally
   without real credentials. If the app has no such path, say so; agents cannot
   review pages they cannot reach.
<!-- /keep-if -->
3. Capture each changed page at both widths with a headless browser:
   - **Phone:** {{phoneViewport}}, touch emulation on.
   - **Desktop:** 1280x900.
4. Read the screenshots. **You are the judge.** You know what you changed, so
   review the shots yourself against the checklist below.

Never paste screenshot contents into PR bodies, commits or comments if the page
shows real user data. Describe what you saw generically.

## What to check

- **First screen at 390px.** Does the thing the page is for show up without
  scrolling? Headers, banners and filters that push it below the fold are a finding.
- **Tap targets.** Roughly 44px or more, not crowded, nothing that only works on hover.
- **Overflow.** No horizontal scroll, no clipped text, no table forced wider than the viewport.
- **Both themes, if the change touches colour.** Check the other theme by hand,
  or say you did not.
- **Redirects and error states.** If a shot is the login page or an error page,
  you did not review the page.

## Gotchas

- **Scrolling may happen inside a container, not the window.** A plain full-page
  screenshot then stops at one viewport. Un-clip inner scroll containers before
  capturing, or scroll and stitch.
- **Fixed and sticky elements land mid-image in full-height shots.** A bottom nav
  is drawn where the first viewport ended. That is how the shot was taken, not an
  overlap bug. Judge the first viewport as the real first screen.
- **Use a free port.** A busy port can make the readiness probe hit someone
  else's server.
- **Headless browsers may come up in the dark theme.** A dark shot is not a regression.
