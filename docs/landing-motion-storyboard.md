> Superseded by revision 3: [scroll-sequence production](landing-sequence-production.md). The user changed the direction to a warm storybook 3D image sequence, with a scroll-owned playhead. This document preserves the earlier research and blocking proposal.

# Lifeline: human story and scroll motion

Revision 2 · 3 October 2026 · Preproduction

The user selected the human story: a person at home, a possible fall, and a reply arriving. No footage has been generated. The storyboard establishes the shots and the film-to-site transition before Higgsfield production.

Review the [interactive blocking study](http://127.0.0.1:8890/storyboard). It contains deliberately schematic artwork, not finished film. The actual root landing page is the earlier version until this sequence is settled.

## Research that changed the direction

### Photon

- [Public homepage](https://photon.codes/): inspected in a browser. Its current hero uses black, white, a tight sans-serif headline, translucent overlapping spectrum panes, and a blue dashboard action. Native messaging is central to its product story.
- [Brand guide](https://photon.codes/brand): inspected the mark/logotype downloads, black and white treatments, and instructions for pairing wordmarks with generous clearspace. The official logotype SVG is used in the dashboard's “Messaging via” credit. It remains distinct from Lifeline's own name and mark.
- [Public product sign-in](https://app.photon.codes/): inspected without signing in. Computed typeface is Aspekta, with black text and a neutral light surface (`rgb(250,250,250)`). The authenticated dashboard was not accessible from this public view; the new Lifeline workspace structure is a design choice, not a claim to replicate unseen Photon screens.
- [Aspekta's official source](https://github.com/ivodolenc/aspekta): obtained the variable WOFF2 and SIL Open Font License from its publisher. Photon's public marketing site uses a different display face; we use the product-facing Aspekta in the dashboard rather than redistributing a commercial marketing font.

Dashboard decisions: neutral white/pearl surfaces, black primary actions, blue responder messages and acceptance actions, soft borders, quiet provenance labels, and decorative spectrum layers above the working area. State colors remain meaningful; decoration never stands in for sensor measurements.

### David Whyte Experience

- [Awwwards entry](https://www.awwwards.com/sites/david-whyte-experience): identifies watercolor mouse interaction, landscape reveal, and scrolling through landscapes.
- [Original experience](https://davidwhyte.com/experience/): inspected the opening and a scroll transition in the browser. The landscape occupies a shared canvas-like stage; text dissolves/reveals while the scene changes. Atmospheric imagery and restrained pacing carry the narrative.
- [Immersive Garden's primary case study](https://immersive-g.com/projects/david-whyte-experience/): confirms dynamically rendered watercolor paintings, 3D WebGL visuals, and custom sound. The original is an interactive rendered experience, not simply a background movie.

Our adaptation combines human film with browser-composed text, messages and masks. The emotional continuity comes from one scene holding while its frame becomes part of the page. A generated video supplies imagery; HTML/CSS supply exact information and interaction. We do not need Figma for this production path.

## The eight frames

Times describe a proposed 30-second master sequence. In the website, scroll distance controls progression; the visitor is not forced to watch for 30 seconds. The first four seconds can breathe as a muted opening clip until scrolling begins.

| Frame | Film / composition | Website layer | Scroll transition and purpose |
| --- | --- | --- | --- |
| 1 · 0–4 s · 0–12% | Wide, eye-level apartment shot. One fictional adult in a muted blue/gray shirt moves near a sofa. Late afternoon window light, slow lateral drift, ordinary life. Subject on the right half, left half open. | Small scroll cue only. The opening is full bleed, with no headline covering the human moment. | Ambient movement establishes a person before a product. Native scrolling takes over the sequence. |
| 2 · 4–7 s · 12–25% | A shift in balance. Cut before impact. A matching lower camera finds the same person seated on the floor beside the sofa, awake. Hands and breathing are natural; no injury close-up. | One short line: “When something happens.” It enters after the seated shot settles. | Camera motion slows and the composition holds. The page does not sensationalize the fall. |
| 3 · 7–11 s · 25–38% | Medium close shot of the wearer and the chest device. A pause, then the person responds. Maintain the same room, shirt, light direction and screen position. | “Do you need help?” followed by a clearly labeled illustrative wearer statement, “I fell. I can’t stand up.” Exact text is HTML, not generated pixels. | A small blue response pulse emerges at the device. This is the first visible bridge from person to system. |
| 4 · 11–14 s · 38–50% | Hold the human shot; depth and negative space carry the transition. | Blue light crosses the scene through a short stack of translucent spectrum planes. A communication boundary forms at right. | The panes reveal an HTML conversation panel. This is browser motion, with controlled timing and crisp edges. |
| 5 · 14–18 s · 50–63% | The person remains in the scene; film dims slightly behind the conversation. | A fictional responder's blue iMessage-style reply: “I’m on my way. Stay where you are.” Source label remains visible. A return pulse reaches the wearable. | The message arrives before the product explanation. The responder's words are the emotional hinge. |
| 6 · 18–22 s · 63–75% | Brief inserts: a hand takes keys, feet leave a doorway. Return to the wearer hearing the reply. The wearer stays seated; expression softens slightly. | “A reply becomes a next step.” Keep text short. Optional sound is user-activated; no audio is required to understand the story. | Connection becomes action. A departure image does not imply arrival, resolution or medical recovery. |
| 7 · 22–26 s · 75–88% | Hold the final wearer shot; stop camera motion so the composition can move without a jump. | Pearl background and Lifeline navigation emerge. “A reply. A person. A next step.” appears at left. The response bubble stays aligned to the film. | The film shrinks from full-screen to a rounded panel on the right, about 52–54% width. The mask, crop and position follow the same scroll progress. The final filmed pose is continuous across the transformation. |
| 8 · 26–30 s · 88–100% | Film becomes a quiet held frame/short ambient loop within the layout. | The message remains beside the person. Below: Notice → Check in → Connect → Follow through, then source-separated context and the care dashboard action. | Release the pinned stage into document flow. Ordinary page scrolling continues. The visitor can reach the dashboard at any time. |

## Art direction and continuity

- One fictional adult; no resemblance or identity claim about Tazeem or Morgan Rivera. The film is labeled illustrative. Use the same reference person and room for every wearer clip.
- Apartment geometry: sofa at left, window at right, floor area between them. Preserve a clear left area for later typography and a subject within the center/right crop safe zone.
- Palette: slate/blue shirt, warm natural light, charcoal shadows. Photon spectrum appears only at the communication transition, then neutral pearl surfaces and a clear message blue.
- Camera: restrained eye-level 35–50 mm feel. Slow drift in frame 1; a cut to the aftermath in frame 2; locked or near-locked human shots for frames 3–5 and 7. No fast orbit or arbitrary push into a phone screen.
- Text, logo, wearable prompt wording, phone UI and state labels are rendered separately in the browser. Film prompts must request no visible text, logos or fabricated readable interface.
- Sound, if later added: room tone, one restrained check-in, one message cue and the reply. A visible mute control and captions carry the same information. Initial generation can remain silent.

## Higgsfield production plan

Catalog checked using the connected Higgsfield model tools. No generation job submitted and no credits spent.

1. Create consistent reference frames for the room, wearer standing, wearer seated and final held composition after the frames are settled.
2. Generate three controlled clips with reference start/end frames: apartment → seated aftermath; wearer check-in → held response; responder departure inserts → wearer hearing reassurance. Build the spectrum/message transition in code so its frame accuracy does not depend on a generative model.
3. MiniMax H3 currently supports start/end frames, 2K output, 16:9 and 9:16, and 4–15 second clips. It is a candidate for controlled continuity. Kling 3.0 supports start/end frames, 3–15 second clips and silent generation; it is a candidate for the short human action inserts. Select using credit preflight and the reference requirements at production time, rather than assuming a catalog price.
4. Keep a 16:9 desktop master and a deliberate mobile crop/reframe. Do not merely crop away the actor or the device. Mobile final composition stacks the headline and film instead of squeezing two columns into 390 pixels.
5. Review actor consistency, hands, device placement, body posture, the seated aftermath, and final-frame stability before integrating any clip.

## Browser composition and performance

The target is one pinned native-scroll region followed by normal document content. The storyboard already demonstrates progress calculation and the end-frame transformation. It does not yet seek real video or implement the finished landing choreography.

For production: muted `playsinline` video with a poster; an opening ambient beat, followed by scroll-to-time mapping using `HTMLMediaElement.currentTime`. Changing that property seeks the media, as described in [MDN's currentTime reference](https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/currentTime). Update only the latest desired time, cap repeated seeks while a seek is pending, and use `requestAnimationFrame` for DOM transforms.

Encode short independently seekable clips with frequent keyframes and fast-start metadata. Start with 1080p desktop and a lighter mobile rendition, then measure seek latency and transferred bytes on actual mobile hardware. An image sequence is an alternative if measured seeking is poor; do not choose it without considering memory and download cost.

Lazy-load the later film segments. The poster and HTML story remain usable when media is slow or unavailable. Under reduced motion, use stills, regular-flow text and the same response narrative. Keep keyboard links, a Skip story action, pause controls for ambient motion, and no forced audio.

## Review boundary

The dashboard has been rebuilt in code. The storyboard is ready for frame review. The next step is to settle any shot/content changes, then generate reference frames and film through Higgsfield and replace the earlier landing page with this sequence.
