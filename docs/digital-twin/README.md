# Offline sensor-space motion lab

Open `/motion-lab`, or the landing page’s **Our digital twin** section. The supplied
Apartment 111 asset provides context. An articulated proxy demonstrates chest
WILi and waist AirPod placement without rigging or changing the scanned person.

Fall + stillness, rhythmic shaking, and gait scenarios have deterministic poses,
attachment positions, local acceleration including gravity, angular rate,
source labels, timing windows, and exportable JSON. A 2 g clipping indicator shows
the chest board’s limited range. The 28-day gait sketch retains step intervals,
sample counts and interval CV. These daily intervals are an independent illustrative
fixture, not measurements extracted from the animated proxy or the wearer.

The proxy’s 60 Hz virtual sampling is not a claim about WILi’s measured cadence.
Its movement amplitudes, frequency and contact/rebound path are assumptions.
Acceleration is `R^-1(a_world - gravity_world) / g`; angular rate is a central
rotation difference. This is kinematics, not a validated biomechanical/contact model.

## Existing rigging code, ready for later

`scripts/digital-twin/vendor/rigify-basic-human.py` is the unchanged official
Blender 5.1.2 Rigify template, with its GPL license and provenance. The wrapper
reuses the bundled `rigify.generate.generate_rig`; it does not invent a rigger.

**Neither Blender script has been executed. No metarig, weights or new Blender
file were generated, and the original apartment/person asset is unchanged.**

Future opt-in sequence:

1. `rig-person.py --prepare --input <original.blend> --output <new-preparation.blend>`
   creates an unfitted basic-human metarig in a separate copy.
2. In Blender, fit the bones to the supplied supine mesh, review rest pose and
   set `LIFELINE_metarig["lifeline_fit_reviewed"] = True`. Rigify does not infer
   anatomy from this Gaussian-derived mesh. Automatic weights may require cleanup.
3. `rig-person.py --generate --input <fitted.blend> --output <new-rigged.blend>`
   generates the rig, requests automatic weights, and adds chest/waist anchors.
   Review weights and exact anchor placement/local orientation before animation.
4. Create/review fall, shaking or gait animation in that copy. Then use
   `sample-attachments.py --input <animated.blend> --scenario fall --output <new.json>`
   to export evaluated anchor poses and kinematic IMU values. This exporter is
   also included but unexecuted. It never saves the input blend.

Run these explicitly through Blender’s `--background --python <script> -- <args>`
only when rigging is wanted. There are no build/start/install hooks that run them.

## Separation from the live system

The browser lab has no `/api` fetch, WebSocket, live sensor packet schema, detector
import, calibration call or threshold mutation. Exports use incompatible
`lifeline.offline-*` schemas and `synthetic-*` provenance. They are rejected by the
live packet validators. `npm run twin:export` writes only `output/digital-twin`.
It has not been run as part of this integration.

Live fall detection remains `wili-waist-provisional-v1`: impact, correlated waist
movement, settling and continuous quiet. **No fall thresholds were changed.**
New `sustained-shaking-exploratory-v1` uses a continuous four-second real two-source
window, repeated signed waist rotation reversals, chest variation, fresh/aligned
unclipped streams, and a cooldown. Missing/stale/sparse data produces no candidate.
The finding opens an unresolved check-in for unusual movement, not a seizure
diagnosis. A current first-person seizure report requests help immediately and
the original words reach the handoff. Negated, historical, hypothetical and quoted
reports do not satisfy that current-report rule.

Neither software fixture tests nor these illustrative traces establish clinical
sensitivity/specificity. Tonic-clonic wearable detection is a specific validation
problem; the [ILAE guideline](https://www.ilae.org/guidelines/guidelines-and-reports/proposed-clinical-practice-guideline-for-automated-seizure-detection-using-wearable-devices)
does not validate this implementation.

## Judge answer

“Our current fall detector is rule-based: chest impact, correlated waist motion,
then sustained stillness. We retain the measurements and timing behind each
trigger. The motion lab is a separate synthetic environment for inspecting sensor
placement and time windows. It does not train the live detector or prove accuracy.”

## Verification

Pure kinematics tests cover gravity at rest, derivatives, placement, clipping,
exports and schema rejection. Actual protocol fixtures cover shaking duration,
one-site motion, gait-like slow reversals, missing samples, unsynchronized clocks,
saturation, escalation and quote retention. Rig scripts receive Python syntax
checks only; no Blender execution or rigging verification is claimed.
