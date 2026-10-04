# Early check-in profile

`LIFELINE_DETECTION_PROFILE=early-checkin` enables a sensitive, autonomous check-in for a controlled descent without needing floor contact or post-event stillness. Default `fall-confirmation` retains the original acceleration + waist movement + quiet window detector.

Both profiles use real WILi chest acceleration and AirPod waist measurements. Early check-in requires current calibrated waist data, aligned timestamps within 100 ms uncertainty, chest acceleration at least 1.65 g on the stock 2 g board (2.5 g on higher-range boards), and waist linear acceleration at least 0.4 g or angular speed at least 1.2 rad/s within 750 ms. The chest event must be no more than 1.5 s old. Already-consumed samples and a 20 s cooldown prevent retriggering.

Evidence is labelled possible loss of balance. This does not measure descent height, prove an unavoidable fall, or diagnose injury. Ordinary vigorous paired motion can also start a check-in. The wearer is asked first; explicit help or unresolved timeout uses the existing coordination policy. No dashboard operator is required.

The original full fall detector and sustained-shaking path remain available. A backend restart resets in-memory waist calibration; use the three-second calibration guide before movement testing.
