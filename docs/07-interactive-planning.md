# 07: Interactive planning (software only)

This replaces the hardware table and sensor node from earlier drafts. The goal is the same: let non-experts reshape a plan and see trade-offs instantly, and be honest about where the plan is uncertain.

## Meeting mode

- Route: `/meeting/:planId`. Full screen, large type, high contrast, works on a projector or a touchscreen laptop/tablet.
- **Tile tray:** Homes, Park, Stop, Convert to housing, Convert to hotel. Drag a tile onto a parcel (new build, park, stop) or a building (conversions).
- **Validity check on drop:** if the target isn't eligible (for example, Convert on a building the legal check rules out, or Homes inside a flood zone), the tile snaps back and a short reason appears with its citation or factor.
- **Scoreboard:** homes, walk access %, transport CO₂ avoided, embodied carbon saved, pencils yes/no per site; each change animates a +/− delta.
- **History:** undo, reset, and a list of changes made in the session, so a facilitator can recap ("We added a park on lot C, which cost 48 homes and raised walk access by 15 points").
- Each drop sends an `Edit` to `/api/plan/{id}/rescore`; no LLM is involved, so it stays under 1 s even offline.

## Uncertainty queue

- The transit agent's `measurements` (for example, "manual weekday count at stop S4, 7–9 am") appear in a panel titled "What would make this plan more certain."
- Each item shows the current range, the expected narrowed range, and which decisions depend on it.
- In the demo, a "Simulate count" button applies a sample count from the fixture to show the range narrowing. Label it clearly as simulated.

## Acceptance

- [ ] Dragging a tile updates the scoreboard in under 1 s with Wi-Fi off.
- [ ] Invalid drops are refused with a reason that cites a rule or factor.
- [ ] Undo and reset restore the exact previous numbers.
- [ ] The uncertainty queue shows at least one item per locale, and the simulated count is labeled as simulated.
