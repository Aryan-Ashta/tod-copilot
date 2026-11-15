# 07: Interactive planning (software only)

This replaces the hardware table and sensor node from earlier drafts. The goal is the same: let non-experts reshape a plan and see trade-offs instantly, and be honest about where the plan is uncertain.

## Edit mode

- Route: `/edit/:planId` (`src/screens/EditScreen.tsx`; old `/meeting/:planId` links redirect there). Full screen, large type, high contrast, works on a projector or a touchscreen laptop/tablet. The Layers panel sits at the top left of the map.
- **Starting point:** the map and stats show existing conditions plus the session's edits. The agents' plan is a suggestion: the "Apply agent suggestions" button at the top of the left panel (shown until applied) adds an `apply_suggestions` edit, which builds the suggested sites and transit.
- **Tile tray:** Homes, Park, Stop, Convert to housing, Convert to hotel. Tiles are click-to-place: click a tile to arm it and the valid targets on the map highlight (parcels for new build, park and stop; buildings for conversions); click one to place the tile. Esc or clicking the tile again cancels.
- **Validity check:** the highlighted targets mirror the backend checks (`src/tools.ts` `validTargets`) and leave out targets the tile would not change: Park on a proposed park or a lot inside an existing park, Stop on a lot a plan stop already stands on, Homes where the plan already builds, and Convert to a use the building already has (as it stands, or as the plan converts it). If the backend still refuses a placement (for example, Convert on a building the legal check rules out, or Homes inside a flood zone), nothing is placed and a short reason appears with its citation or factor.
- **Scoreboard:** homes, affordable homes, walk access %, transport CO₂ avoided, embodied carbon saved, and the funding required; affordable homes and the funding required (sum of each site's positive funding required) count funded sites only, matching the Funding card's goals table. Each change animates a +/− delta. Edit mode never reselects sites.
- **Plan history:** numbered entries with an icon per change, where it was placed and a delta chip for each stat it moved; hovering an entry shows a remove button that removes that entry (any entry, not only the last). Undo and Reset sit under the list. A Park or Stop entry that moved no number says why: walk access counts new homes and the plan has none yet, every new home already has a park (or frequent transit) within walking distance, or no new home that lacked one is within walk. A facilitator can recap from it ("We added a park on lot C, which cost 48 homes and raised walk access by 15 points").
- **Statistics:** animated values with a contribution bar per stat split by history entry (keyed by entry number) and markers for existing conditions, your plan and the agents' plan.
- **Green-space slider:** a compact one-row homes ↔ green-space slider floats on the map above the tile tray (the same compact slider the plan screen's targets strip uses). It is a plan-wide setting, not a step: its edit always stays last in the edit list, so it applies to every new build (the agents' and tiles placed later) and its history entry shows its whole effect; Undo removes the most recent change.
- **Map:** lots taken by a proposed park or a new build drop their underused tint, and a demolished building loses its selection outline.
- **Pencil hints:** a hand-drawn intro (pick a tile → click a highlighted spot) until the first change; after each change, pencil circles on the new history row and the stats it affected, a faint "=" beside each unchanged stat, and "no effect" on the row when the change moved nothing.
- Edits persist per plan in `sessionStorage` (`transitor.edits.<planId>`), so the plan screen and edit mode share them.
- Each placement sends the edit list to `/api/plan/{id}/rescore` with `from_existing: true`; no LLM is involved, so it stays under 1 s even offline.

## Uncertainty queue

- The transit agent's `measurements` (for example, "manual weekday count at stop S4, 7–9 am") appear in a panel titled "What would make this plan more certain."
- Each item shows the current range, the expected narrowed range, and which decisions depend on it.
- In the demo, a "Simulate count" button applies a sample count from the fixture to show the range narrowing. Label it clearly as simulated.

## Acceptance

- [ ] Placing a tile (click the tile, then a highlighted target) updates the scoreboard in under 1 s with Wi-Fi off.
- [ ] Invalid targets are not highlighted, and a placement the backend refuses shows a reason that cites a rule or factor.
- [ ] Undo and reset restore the exact previous numbers.
- [ ] The uncertainty queue shows at least one item per locale, and the simulated count is labeled as simulated.
