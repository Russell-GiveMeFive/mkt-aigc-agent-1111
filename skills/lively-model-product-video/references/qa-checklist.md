# QA checklist

Score each category 0–2. Reject any result with a critical failure or total below 9/12.

| Category | 0 | 1 | 2 |
|---|---|---|---|
| Identity | different/melting face | small drift | stable identity |
| Liveness | frozen/robotic | limited micro-motion | breathing, gaze, expression, balance feel human |
| Skin | oily/plastic/waxy | mildly over-smoothed | matte-natural with plausible localized highlights |
| Hands | extra/fused/broken | small grip issue | stable five-finger grip and connected joints |
| Product | morphing/unreadable | minor text drift | stable geometry, color, label, details |
| Scene | background/text warped | minor flicker | locked and clean |

## Critical failures

- extra/missing fingers;
- product changes identity or label;
- face identity visibly changes;
- full-face greasy shine or wax texture;
- hand/product disconnects from arm;
- background title or logo deforms;
- product presentation is only a camera zoom.

## Retry mapping

- Identity/skin failure → raise identity strength, lower motion strength, shorten product travel.
- Hand failure → preserve source grip, reduce wrist rotation, move forearm as one unit.
- Product failure → increase product reference weight, reduce occlusion/rotation, shorten near-lens hold.
- Dead performance → add one blink, micro-saccade, smile change, breathing, and shoulder counter-motion; do not add large swaying.

