# LIFELINE scroll sequence — revision 7

## Revision 7 — momentary blur vision at the fall cuts

The same revision 6 images now receive a scroll-owned focus effect in the browser. A restrained softening marks the onset of imbalance; stronger blur bridges the braced-landing cut at 28% and the seated-aftermath cut at 35%. Focus returns by 30.5% between those cuts so the impact remains legible, and by 37.2% after the aftermath cut. A small overscan and faint neutral veil suggest lost focus without moving the camera or introducing spectral color. DOM messages and controls remain crisp. No elapsed-time animation runs when scrolling stops, and reverse scroll retraces the same envelope. Static mode clears the effect; reduced motion disables it.

Verification: JavaScript syntax passes. Chrome checks on desktop and mobile confirm peak blur at both cuts, zero incident blur between/after the transitions, identical focus on reverse scroll, clear static mode and disabled reduced-motion effects. No page errors or horizontal overflow. Screenshots and measured styles are saved in `output/ui-design/landing-v7-*`.

## Revision 6 — expression continuity at the incident cuts

Removed the smiling lead-ins from both affected shots using the existing source footage. Failed recovery now samples `imbalance-v4.mp4` from 5.10–6.00 seconds, starting with a concerned expression and an active attempt to catch balance. Check-in now samples `seated.mp4` from 1.65–3.00 seconds, entering after the seated smile has resolved into concern. The following words chapter still starts at 3.00 seconds, so it continues the same source action.

The 260-frame timeline, chapter boundaries, braced impact, responder action and final held image are retained. Both desktop and portrait renditions are rebuilt from these trims without synthetic frame interpolation. Manifest revision 6 records the source trims; frame requests include that revision so previously cached smiling frames are replaced on refresh. The previous contact sheet and affected boundary frames remain in `output/lifeline-sequence/contact-sheet-v5.jpg` and `cut-review-v5/` for comparison.

Verification: all 520 WebP files decode at their expected dimensions. The final held frame's SHA256 is unchanged. Chrome checks at 1432×988 and 390×844 render frames 39→40, 69→70 and 79→80 correctly, continue to the words/responder/final hold, and retrace both affected cuts on reverse scroll. All canvas-frame fetches use revision 6; there are no page errors, failed media responses or horizontal overflow. Evidence: `output/ui-design/landing-v6-verification.json` and `landing-v6-*-cut-*.png`. The existing 8890 preview serves the update without a restart.

## Revision 5 — coordination and signal sections

The source imagery remains revision 4. The browser now supplies the expanded human/coordination narrative: WILi speaks first with proposed warm film wording, Liam explicitly requests help, a scroll-driven waveform and attributed context appear, and a Citadail-inspired DOM phone carries the responder exchange. The room is labelled illustrative; shared-group transport and a distinct HCP role are not claimed as deployed backend features. The medication attachment uses the saved Finch synthetic example, not a clinical record belonging to the fictional wearer.

The phone and bubbles use staggered translation, restrained overshoot and motion blur controlled directly by scroll. The respondent image lingers on source poses 175–184 while the conversation runs; later frames advance through the keys action after departure. Maya's acceptance at 61% of the responder chapter introduces the first spectral cue; her departure at 71.5% is separate. Mobile centers the phone over a softly defocused scene. Speech collapses into its reported context before it can cover the wearer's face. The exact final frame 259 still reframes through the same canvas.

The Signal section is one pinned canvas: normal → fall-like spike, normal → seizure-like rhythmic motion, then increasing gait variability over days. The vertical domain expands during each chapter; the time axis changes from 12 seconds to 8 seconds to 28 days. Traces are authored illustrative data, not a live device stream or detection validation. Seizure and gait chapters are marked research directions. Reduced motion exposes three ordinary static charts.

Hospital context now contains an inline SVG EHR image placeholder. Replace the `src` of `#ehr-placeholder` in `public/landing.html` when the real screenshot is supplied; its container and dimensions are ready. The closing story transcript, prototype accordion, repeated evidence list, and footer have been removed. The page ends with the care-workspace action.

Verification: `node --check public/landing.js` passes. Chrome checks at 1432×988 and 390×844 found no page errors, horizontal overflow, or operational API/live connections. All three signal phases and domain changes render. Reversing to 64% restores frame 177, the earlier medication exchange and unassigned state. 96% holds frame 259 in one canvas. Static-mode control and reduced-motion paths work; reduced motion renders all three charts. Mobile speech/context was shortened after screenshot inspection. Evidence is in `output/ui-design/landing-v5-verification.json` and `landing-v5-*`, `signals-v5-*`, `ehr-v5-*` screenshots. The existing isolated preview at 8890 serves the changes without a restart. This task did not operate the hardware server or native bridges.

## Revision 4 imagery and production history

The viewer owns the playhead. The landing renders WebP frames into a single canvas; it has no video element, autoplay, temporal smoothing, or autonomous motion. Stopping scroll holds a frame. Reverse scroll retraces the same poses and cuts. This supersedes the conventional film proposal in revision 2. Revision 4 responds to the user’s observation that the incident looked like floating: it adds an explicit failed recovery and braced landing before the aftermath cut.

## Art direction

User references: soft vertical spectral bands and a painterly 3D mascot. The human story is rendered in that mascot's material language: rounded fictional human characters, matte clay faces, woven clothes, soft handmade furniture, warm ivory plaster and quiet afternoon light. The rice-bowl subject itself is not part of the care story. The base stays warm and tactile; spectral color first appears in the negative space when the wearer hears the responder’s words. It is absent during the incident, notification, and final reframe. It never substitutes for an operational sensor or incident status.

The first two scenes are almost wordless. The first explicit behavior is “Do you need help?” Exact copy, attribution, and blue responder replies are HTML. None are generated inside the imagery. A brief non-graphic braced landing depicts weight reaching the rug. No injury, medical recovery, or guaranteed arrival is depicted.

## Spatial timeline

| Scene | Scroll | Frames | Composition and action |
| --- | --- | --- | --- |
| Ordinary life | 0–14% | 0000–0039 | Quiet apartment, small glance and breath. |
| Failed recovery | 14–28% | 0040–0069 | Slipper skids, knee buckles, torso loses alignment, hand misses the table. |
| Braced landing | 28–35% | 0070–0079 | Hip reaches rug; palm and bent elbow take weight. Hold the compressed posture before cutting. |
| Check-in | 35–49% | 0080–0119 | Cut to awake aftermath. “Do you need help?” |
| Their own words | 49–57% | 0120–0159 | “I fell. I can’t stand up.” |
| A person responds | 57–77% | 0160–0219 | Idle → notification → noticing → reply → keys. DOM incoming message precedes the reply-sent cue. |
| Waiting, connected | 77–88% | 0220–0259 | Return to wearer. Exact responder reply, faint cool spectral light in left negative space, calmer settling. |
| Same-frame reframe | 88–100% | **Hold 0259** | Same canvas/bitmap contracts into a card; margins, corners, navigation, sparse headline. |
| Product | After sticky story | **Hold 0259** | Normal page flow. Notice → Listen → Connect → Follow through. |

The reframe is scroll-driven, including its easing. There is no timer continuing after the user stops. Its scroll span is about two-thirds of a viewport. The user can make it arbitrarily slow, fast, or reverse it; the earlier 1.2–1.8-second timing idea is a pacing reference, not an autonomous animation timer.

Final copy: **LIFELINE / When something happens, someone follows through.** No paragraph in the reframe.

## Production and source media

Higgsfield `gpt_image_2_5`, high quality, 2K, 16:9 for reference stills. The opening reference defines character identity, wardrobe, geometry and materials. Subsequent references use that completed generation as their image reference.

| Reference | Higgsfield job |
| --- | --- |
| Ordinary life | `59bc8cf1-22f3-444e-be08-372e79764038` |
| Slight instability | `20179e57-c0e1-448b-9596-4d73c806c55b` |
| Seated aftermath / final composition | `3faf3152-96e5-443e-9d2d-0cdda24959bc` |
| Responder and keys | `ac19cdcd-33fe-483d-8837-c405ef97bd4d` |

Revision 4 adds reference stills using the same GPT Image 2.5 settings and original character/room references:

| Reference | Higgsfield job |
| --- | --- |
| Failed recovery | `d84669d6-4a83-408c-a579-580e4e832f3b` |
| Braced floor contact | `d27807e7-b2c1-4c8f-82fc-ad45403f9bd6` |
| Responder before notification | `6b833c8c-0e04-4ec0-98e9-e075379aa208` |

Higgsfield MiniMax H3, 2K, 16:9. New sources retain crisp shutter, locked camera, stable identities and no generated text. The fall source is directed with a short gravity-led drop followed by visible contact and a held braced pose; footage was inspected before integration. The failed-recovery source uses seconds 2–6, and the landing source uses its first 2.5 seconds, keeping the visible drop and compression while cutting the long tail of settling.

| New source | Duration | Higgsfield job |
| --- | --- | --- |
| `imbalance-v4.mp4` | 6 seconds | `38515ca6-de04-49db-8d18-41f874de15c8` |
| `impact-v4.mp4` | 6 seconds | `9c61a72f-418b-491d-844f-ca1b8ce9016a` |
| `responder-v4.mp4` | 8 seconds | `d36cb02c-fd51-45d1-861f-04ac51a5d5f8` |

The ordinary-life and seated check-in/waiting sources remain from revision 3. The exact final frame remains 0259. Earlier source videos are preserved; `contact-sheet-v3.jpg` retains the previous cut for comparison.

Exact new prompts, parameters, job IDs and result URLs are preserved in `output/lifeline-sequence/production-v4.json`; original provenance remains in `production.json`. No new Higgsfield project is created; the saved preference is `auto_create_project:false`.

`scripts/build-landing-sequence.py` extracts actual source poses with ffmpeg, then encodes WebP with Pillow. It adds no optical-flow interpolation. It produces desktop 1280×720 and portrait mobile 648×1152 renditions, both 260 frames. Mobile crops from the full-resolution source. Its focal alignment shifts gently from 86% to the right edge during failed recovery, then holds there through the landing so the weight-bearing palm stays visible. Other scenes use 86% alignment. Desktop uses a fixed right-aligned cover crop to preserve the support hand in taller viewports. The contact sheet includes denser samples around the impact and each side of the editorial cut.

## Loading and interaction

- First frame and scene compositions are prioritized. Remaining compressed frames preload at idle with four background fetches; an extra slot remains available for a requested pose.
- Only a bounded window and scene anchors are decoded. Unneeded `ImageBitmap`s are explicitly closed. Full decoded sequences are never held in memory.
- A DPR-aware backing canvas is capped at the rendition's native width. CSS cropping and the changing container keep the same frame visible through the reframe.
- A complete text transcript, Skip story link, and care-workspace link stay available. Reduced motion, unsupported canvas/bitmap APIs, or unavailable initial media use a static held image and regular document content. A visible control also turns off the scroll motion.
- The root makes no operational API requests, sends no messages and issues no incident commands. Fictional film characters, real wearer Tazeem, and synthetic Finch patient Morgan Rivera stay separate.

Browser implementation references: [MDN canvas optimization](https://developer.mozilla.org/en-US/docs/Web/API/Canvas_API/Tutorial/Optimizing_canvas) for DPR and backing-store considerations; [MDN createImageBitmap](https://developer.mozilla.org/en-US/docs/Web/API/Window/createImageBitmap) for decoding source images. These complement the [Photon brand guide](https://photon.codes/brand) and [Immersive Garden's David Whyte case study](https://immersive-g.com/projects/david-whyte-experience/), which describes rendered interactive landscapes rather than a simple background movie.

## Preview boundary

The preview is `http://127.0.0.1:8890/`, isolated from credentials, responder phones and physical devices. Only its process is restarted for static-serving changes. Main port 8877 and the hardware/native bridges are left running. The main server serves a styled static fallback with an embedded copy of frame 0259; new sequence asset routes require its next coordinated restart. This UI task does not restart it.
