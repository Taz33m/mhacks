# LIFELINE UI handoff — revision 4

3 October 2026. The user requested a full visual reset, a Photon-informed dashboard, deeper research, and a human landing story. After the initial storyboard, the user changed the production direction to a scroll-owned image sequence and supplied tactile 3D mascot and spectral-gradient references.

## Current result

- [Full landing preview](http://127.0.0.1:8890/): generated warm storybook 3D scenes, 260 WebP frames per rendition, one canvas, deterministic forward/reverse scrubbing, and the held final frame becoming a product card. No video element or autoplay. Sparse final copy: **LIFELINE / When something happens, someone follows through.**
- [Care dashboard](http://127.0.0.1:8890/dashboard): the earlier Photon-informed rebuild remains. Aspekta type, neutral rail/workspace surfaces, black actions, blue replies, restrained spectrum accents, and distinct official Photon attribution.
- [Production specification](landing-sequence-production.md): spatial timeline, shots, prompt provenance, exact job IDs, loading strategy and source references.
- [Earlier storyboard](http://127.0.0.1:8890/storyboard): preserved as a clearly labeled blocking study. It is superseded by the current landing. The earlier Figma file is historical; this revision is implemented directly in code.

## Production and files

Revision 4 adds a buckled-knee failed recovery, a braced hip/palm landing, and a responder whose attention changes after a notification before picking up keys. The wearer hears the human reply on the return cut, with faint spectral light confined to the left negative space. Scene spacing is unequal: the 10 landing frames occupy 7% of scroll, while the 40 ordinary-life frames occupy 14%. The held final frame becomes the product card as before.

- `public/landing.html`: new story and product page; complete text transcript; exact final-frame inline fallback for the still-running main server.
- `public/landing.js`: canvas renderer, scroll-to-frame mapping, explicit cuts, bounded bitmap decoding, preload priority, reduced-motion/static mode, keyboard links and canvas-to-card geometry.
- `public/styles.css`: existing dashboard styles plus a scoped warm/tactile landing layer. Spectral light is reserved for the wearer hearing the human reply. It is absent during the impact, notification and reframe. Landing navigation is instantaneous; there is no timer moving the playhead after scroll stops.
- `public/media/story/manifest.json`: seven scroll scenes and final-frame hold at 88%.
- `public/media/story/desktop/frame_0000.webp` through `frame_0259.webp`: 1280×720, 19.35 MiB total.
- `public/media/story/mobile/frame_0000.webp` through `frame_0259.webp`: dedicated 648×1152 portrait crops from the full-resolution source, 17.80 MiB total. This avoids enlarging a low-resolution landscape image or cutting off the face.
- `scripts/build-landing-sequence.py`: reproducible extraction/encoding pipeline, scene boundaries, contact sheet, and inline fallback synchronization.
- `output/lifeline-sequence/production.json`: exact prompts, parameters, IDs and result URLs. Source PNG/MP4 and review contact sheets are preserved beside it. The earlier photoreal generations are unused. Revision 4 source prompts and IDs are in `output/lifeline-sequence/production-v4.json`.
- `src/server.ts`: only this task's static MIME/allowlist additions. Operational changes elsewhere in this file belong to concurrent work and must be preserved.

The landing does not call operational APIs or issue commands. Film characters are fictional. Tazeem, the real wearer, and Morgan Rivera, the synthetic Finch patient, remain separate.

## Verification

- `npm run typecheck` passes.
- `node --check public/landing.js` passes.
- `node --test src/server.test.ts src/policy-server.test.ts`: 2 tests pass in isolated offline fixtures.
- All 520 WebP files decode and match their rendition dimensions. Inline fallback, held poster and desktop frame 0259 are byte-identical.
- Public HTML/JS/styles/manifest and first, cut and last frame routes return expected MIME types. Unknown media names, private production metadata, traversal paths and missing frames return 404.
- Revision 4 desktop 1432×988 and mobile 390×844: no horizontal overflow. The mobile face, device and keys remain visible; captions do not cover the key action.
- At 32.73% scroll the browser draws braced-contact frame 0076. Forward to the product card and reverse to the same position returns to 0076. There is no independent playhead.
- At 64% scroll, incoming message is visible and reply-sent cue is hidden (frame 0181); at 72.73%, keys are lifted and reply-sent cue is visible (0207). Spectral intensity is zero in both.
- At 82%, the wearer hears the reply on frame 0238; faint spectral light is confined to left negative space. Mobile captions end above the wearer’s face.
- At 94% and 100%, the same canvas draws frame 0259; only its container and page elements change. Mobile reaches the same held frame. Browser error logs are empty.
- The visible static-mode control displays the held still, opens the transcript and retains usable care links. Keyboard Enter on Skip story jumps directly to the normal product section. Reduced-motion preference uses that same static-mode path; no operating-system preference was changed for this check.
- Read-only inspection of the main port 8877 confirms its styled static fallback and loaded final image. Its process and native/hardware bridges were not restarted.

Revision 4 evidence: `output/ui-design/sequence-impact-desktop-v4.jpg`, `sequence-impact-mobile-v4.jpg`, `sequence-responder-desktop-v4.jpg`, `sequence-responder-mobile-v4.jpg`, `sequence-reassurance-desktop-v4.jpg`, `sequence-reassurance-mobile-v4.jpg`, `sequence-checkin-mobile-v4.jpg`, `sequence-product-desktop-v4.jpg`, and `sequence-product-mobile-v4.jpg`. Source-pose review is `output/lifeline-sequence/incident-frames-v4.jpg`; the complete `contact-sheet.jpg` is rebuilt. Earlier evidence files are retained.

The browser checks use responsive viewports, not physical mobile hardware. Mobile compressed media is 17.80 MiB; initial/scene frames are prioritized, with four background requests and a bounded 18-bitmap mobile cache. Physical-device memory/network profiling remains a deployment consideration.

## Live-server boundary

The full motion experience is on the isolated preview at port **8890**, without real messaging credentials or responder phones. The main hardware server at **8877** is kept running. It serves the new static landing through existing HTML/JS/styles routes and an embedded final still. Its compiled static allowlist predates the sequence media routes, so full motion on that port requires the next coordinated restart. This task does not interrupt calibration or restart it.

## Research basis

[Photon homepage](https://photon.codes/), [official brand guide](https://photon.codes/brand), and [public sign-in](https://app.photon.codes/) informed the neutral surfaces, type and messaging accents. The authenticated dashboard was not accessed. Aspekta comes from its [publisher](https://github.com/ivodolenc/aspekta), with the SIL Open Font License retained locally.

[Immersive Garden's David Whyte case study](https://immersive-g.com/projects/david-whyte-experience/) describes interactive rendered watercolor landscapes and WebGL. Our adaptation uses authored character imagery plus browser-composed text and container motion. [MDN canvas optimization](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas) and [createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap) informed DPR handling and decoding.
