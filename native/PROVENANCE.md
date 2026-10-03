# Native implementation provenance

The files `macos/ClubMotionBridge.swift`, `macos/KeepAlive.swift`,
`macos/build.sh`, and `macos/Info.plist` were copied directly from:

`/Users/tazeemmahashin/Documents/ChatGPT/Kinesthetic/native`

Reference repository commit: `1bd0512ecf62a4c756a0331fad8b752509ce43da`.
The Kinesthetic bridge itself credits Aircade's native acquisition pattern.

`KeepAlive.swift` is unchanged. Its Kinesthetic names, comments, and measured
observations remain intact. Those observations are prior-project reports, not
LIFELINE physical test results.

LIFELINE changes the copied bridge's app identity, source/packet contract, port,
health verification, and reporting-bud checks, adds gravity/user acceleration
and a clock-ping receiver, and removes game/player routing. `build.sh` retains
the original non-mutating CLT duplicate SwiftBridging module-map workaround.

`ios/` is a new minimal foreground chest-phone producer and check-in client.
Neither client uses dominant-motion fusion or substitutes simulated readings.

Before a public hackathon submission, disclose this prior implementation and
confirm reuse eligibility with the organizers. This document is provenance,
not a license grant for the source repositories.
