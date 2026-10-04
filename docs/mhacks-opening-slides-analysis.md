# MHacks opening deck — implications for LIFELINE

Reviewed all 95 slides on October 3, 2026.

Source: [MHacks Opening Slides](https://www.figma.com/slides/3cBut9wHzAezWcZ34p34j2/MHacks-Opening-Slides). Slide numbers below refer to the presentation order. Event instructions name [mhacks.org/live](https://www.mhacks.org/live) as the source for current event information; this review establishes what the deck says, not subsequent rule changes.

## Decision

Keep **Actually Intelligent (AI)** as the main track. Prioritize the real incident loop, Photon conversations, grounded clinical context, and coherent design across the wearable and web UI. The deck supports this direction. It does not justify expanding scope to collect more sponsor integrations.

The strongest demonstration connects a physical event, the wearer's own words, an authorized responder's question, a grounded answer, a spoken reply, and an explicitly recorded outcome. The dashboard makes that loop legible while the participants act through their normal interfaces.

## Facts established by the deck

| Topic | What the deck establishes | Slides |
| --- | --- | --- |
| Deadline | Submission is Sunday October 4 at noon. | 21 |
| Main awards | Grand prize is $5,000. The four main tracks are Sustainability, Fintech, Actually Intelligent (AI), and Beyond the Code (Hardware), each $2,500. Award stacking is not established here. | 26–29 |
| Photon entry | Integrate the Photon API. Its theme is agents participating in everyday iMessage conversations with persistent context. The deck presents a month of Pro access through an event promotion; it does not state Enterprise is required. | 65–67 |
| Photon judging | Human collaboration and context across time, channels, and people; assessment of vision, craft, depth, and plausible real use. First prize is $400 cash plus $300 credits and a final-round interview opportunity; runner-up is $200 cash plus $100 credits. | 68 |
| Design | Figma Student Ambassadors advertise **Best Design**. The opening deck gives no detailed design rubric, submission requirements, or textual prize specification. This is separate from the four main tracks. | 70 |
| FREE-WILi | Separate awards include FREE-WILi + AI, hardware, and wireless projects. Judging considers creativity, completeness, and practicality. Each winning team member receives a device/accessory kit; each team can win one of these awards. | 54 |
| FinchNode | First prize is Apple Watches; second is $500 split across the team. The opening slides give little technical or eligibility detail; use the workshop and track instructions for those. | 77–78 |
| Fetch | The agentic workflow must be discoverable through ASI:One and take meaningful action. Prizes are $1,250/$750/$500, with internship interview opportunities. | 86–87 |
| Spacetime | Eligibility requires Spacetime as the core backend and a public repository with complete code. A short video is recommended. First/second/third prizes are $1,000/$500/$200. | 93 |

## Analysis for our product

### Photon should carry the interaction that changes what happens

Our one-agent architecture fits the persistent-context theme: two private human conversations and a wearable share one incident. Multiple agents and a group chat are examples in the deck, not mandatory requirements.

The meaningful proof is conversation in context. The wearer says they cannot stand; the responder receives that attributed statement, asks about documented medication and allergies, gets a sourced answer, accepts responsibility, and sends a reply that the wearable speaks. The system remembers who said what and follows up until an outcome is recorded.

These steps give a reviewer concrete evidence for each Photon dimension:

- **Vision:** the same agent participates across physical interaction and human messaging.
- **Craft:** concise messages, clear attribution, audible replies, and obvious next actions.
- **Depth:** ambiguity, unavailable records, stale replies, duplicate messages, and unresponsive contacts have defined behavior.
- **Plausible use:** approved contacts can complete the response through their phones without operating the dashboard.

Spectrum/Photon supplies the live conversation transport. LIFELINE's backend supplies orchestration, policy, persistent incident state, and model-grounded clinical answers. Present those roles accurately.

Our current explicit responder commands and bound replies provide reliable authority. Broader prose such as “I'm coming downstairs now” can be relayed without proving acceptance or departure. The judged flow must make ownership clear through a supported acceptance action and truthful progress updates. Natural conversation and explicit responsibility need to coexist.

### Make the AI contribution visible

The opening deck names the AI main track but supplies no detailed main-track rubric. Our recommendation is therefore product analysis, not an asserted judging rule.

Show a real model using the incident and returned record context to compose a useful handoff and answer a responder question. One compound question about medications, allergies, and current vitals is a strong test: the answer should include documented source values and say current vitals are unavailable when we only have dated historical readings.

The AI's value is interpreting and selecting context. Timers and authorization remain deterministic. Explain this division plainly when judges ask how autonomy works.

### Finch's read-only role is useful without a pivot

Based on our workshop review and existing requirements, clinical reading can support coordination without hospital writeback. The useful Finch-to-Photon link is that a responder can obtain the relevant documented context while helping, rather than opening an EHR and searching manually.

Keep hospital facts, wearer statements, and responder outcomes separately attributed. The care brief connects them after the incident. A larger wellness or medical platform would dilute the finished interaction we can demonstrate now.

### Design includes the entire response

Best Design gives the separate UI work a concrete target. The deck does not establish that a particular Figma product, a Make-generated app, or a specific number of screenshots is required.

Evaluate the landing page, short calibration guide, incident dashboard, iMessage copy, wearable status, and spoken updates as one experience. Ownership, the next action, and the wearer's words should be understood before telemetry detail. The landing page should explain that human story and show the product; the operational view should expose actual state and evidence.

The separate design handoff now reports implemented desktop/mobile layouts and an editable Figma file. Physical and live-provider verification remain independent of that UI work.

### Avoid backend expansion before the live loop works

Fetch discovery and a Spacetime core-backend migration are substantive requirements. Our existing local orchestration and live dashboard do not establish eligibility for either. Keep them deferred unless the core demonstration is complete and there is enough time to implement and verify the required role.

FREE-WILi + AI is a natural secondary fit for the device already in use. Its completeness criterion favors finishing sensing, listening, speaking, buttons, and incident updates. Wireless is a separate category; the deck does not make a wireless link a prerequisite for the AI award. A working USB demo can precede optional wireless transport.

## Development order

1. Establish one full physical-trigger rehearsal with real WILi audio and mounted AirPod evidence. Preserve actual cadence and gaps; the slides do not establish our board's sampling rate or chest orientation.
2. Complete the actual Photon loop: wearer check-in and statement, responder receipt and acceptance, a grounded question/answer, reply spoken by WILi, progress, and recorded outcome. After setup, no dashboard operator should advance it.
3. Measure real latency and choose a check-in window that allows the spoken reply to finish. A five-second silence demo and a conversational demo may need different explicitly configured timing.
4. Demonstrate one concise edge case, such as unavailable current vitals or a stale duplicate response, without derailing the story.
5. Integrate and review the completed UI, then capture a backup video and prepare truthful submission evidence before noon.

Automated incident rehearsals, local AI previews, individual speaker checks, and observed message deliveries are useful component evidence. They do not yet prove the combined physical-and-live-messaging loop. That combined rehearsal is the highest-value remaining proof.
