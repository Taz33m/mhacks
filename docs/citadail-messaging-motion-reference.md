# Citadail messaging animation — LIFELINE reference

Inspected GitHub main on 4 October 2026, commit `d162b8cbff707ef2e18f674afe500365f9c4c3b7`.

Source: [shell-entry.tsx](https://github.com/Taz33m/citadail/blob/d162b8cbff707ef2e18f674afe500365f9c4c3b7/frontend/components/shell-entry.tsx#L484). Read-only source snapshots are under `output/research/citadail/`. The repository's Pages endpoint returned 404; these findings come from the actual component source, not an observed hosted playback.

## The authored animation

`PhotonMessenger` (line 508) is a framed HTML phone with status bar, island, participant header, message stack, composer and home indicator. It enters near the end of a shared twelve-second Framer Motion loop. Its position and scale resolve together: opacity 0→1, scale .82→1, horizontal offset 46→0 px, vertical offset 16→0 px. The intermediate poses make the phone feel like the next physical object in the process, rather than a card simply fading into view.

`MessageBubble` (line 610) staggers arrivals. First message starts at .928 of the loop; later messages start at .946 + (index−1)×.015. The first scales .82→1.04→1; later messages scale .72→1.02→1. Left/right offsets follow bubble alignment, and vertical offsets increase slightly with index. Blur clears on entry; later bubbles return to a slight 1 px blur during the final hold. Tail geometry and sender labels establish a native messaging shape. The component supports left/right alignment, although this hero's four scripted messages are all left-aligned. A chart arrives as an actual attachment within the same bubble system.

There is no typing-dot component in this messenger. The apparent conversational rhythm comes from the staggered message poses. The existing hero messages are a scripted demonstration, not incoming live messages.

## What to carry into LIFELINE

1. The phone becomes a concrete visual object: wearer quote compacts, then the phone enters and its participant header establishes the destination.
2. Each meaningful message has its own readable arrival and hold. Keep sender identity adjacent to the bubble. Evidence should attach to the answer, as Citadail's chart attaches to its message.
3. Use restrained overshoot and a small sender-directed offset. Keep settled text sharp, with zero residual blur when the visitor stops scrolling. Human role and incident state must remain visible independently of color.
4. Give acceptance its own pose and first spectral cue. Departure is the next explicit message; the keys footage follows that report.
5. Pull out of the phone into Maya's existing physical scene, then return the same progress to WILi. Preserve frame 259's uninterrupted canvas-to-card reframe.

For the LIFELINE landing, map the authored poses to scroll progress instead of copying the twelve-second infinite loop. Eliminate autoplay, repeated message cycles and delayed settling after scrolling stops. Build transforms deterministically so reversing scroll restores the exact prior composition. Provide a reduced-motion transcript.

The animation reference resolves the presentation technique. It does not implement LIFELINE's proposed shared incident room; the current provider path still uses separate bound private conversations.
