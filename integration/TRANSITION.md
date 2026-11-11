# Particle navigation transition

Requested behaviour: clicking Projects float or About boy disperses every visible ocean/body mark upward, clears to cream, then fades destination content in. Remove route camera pan. Preserve landing composition, hover, splashes and intro. Case-study design remains a separate task.

Implementation: script.js captures the composited scene into a GPU texture and scatters its visible marks for 480ms (100ms fade for reduced motion). It emits section-exit followed by section-handoff only after clearing. integration/framer-handoff.html handles both /projects and /about-me, fades home copy during scatter and reveals destination over 220ms, validates message origin/source, and resets on returning home.

Integration required in Framer Portfolio 2.0: replace custom code 'Home Projects Handoff' (G3gcFlcVh) with framer-handoff.html; set placement Head End and run Every Page Visit. Add /about-me prefetch beside /projects. Framer agent API rejected custom-code edits because that experiment is disabled; no Framer edits were applied. Do not merge the scene change without the matching Framer handler: the old handler only supports Projects.

Verification: JavaScript syntax checks passed. Node VM handoff checks passed for both routes, exit-before-navigation, origin/source validation, route allowlist, first-load intro preservation and SPA return reset. GPU visuals/performance and full browser navigation remain unverified. Vercel preview is protected; creating a temporary share link was rejected by automatic approval review pending explicit user authorization. No protection setting was changed. Production remains unchanged.

Next: authorize temporary preview access, inspect effect on desktop/mobile, apply Framer custom code through an authorized supported editing path, test both complete journeys and return paths, then publish coordinated changes.
