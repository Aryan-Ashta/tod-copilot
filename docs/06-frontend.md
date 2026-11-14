# 06: Frontend

Vite + React + TypeScript, MapLibre GL JS with deck.gl layers, Tailwind. Dark theme. One page, three screens.

## Screens

1. **Prompt:** three locale cards, each with its name, data tier badge (CoStar full / Public only) and its one-sentence purpose from `docs/11-test-locales.md`. A text box and "Plan it." Header note: "Concept · estimates, not legal or financial advice."
2. **Plan view (main):**
   - Left column (~640 px): agent checklist (8 rows: pending / running / done / error), then a detail card for the selected agent.
   - Right: map, full height, with a layer toggle panel.
   - Bottom right: targets panel with bars and the homes ↔ green-space slider.
3. **Meeting mode:** projector-friendly full-screen map with large type. A tile tray (Homes, Park, Stop, Convert to housing, Convert to hotel) to drag onto parcels or buildings. A big scoreboard shows homes, walk access, CO₂, embodied carbon saved and "pencils?" with animated deltas. An "Undo" button and a "Reset" button.

## Map layers (bottom → top), each toggleable

| Group | Layer | Style |
| --- | --- | --- |
| Base | Dark base map (`TODO(kickoff)`: tile provider key) | |
| Base | Aerial imagery | off by default |
| Infrastructure | Rail and bus routes (existing) | rail red, bus grey |
| Infrastructure | Sidewalks / bike lanes | thin lines; missing sidewalk frontages in amber |
| Infrastructure | Utilities (where public) | thin dashed lines; "not public here" note when missing |
| Infrastructure | EV chargers, schools, clinics, parks, grocery | small icons |
| Infrastructure | FEMA flood zones | blue hatch |
| Plan | Proposed routes and stops | frequent bus teal/green, BRT thick, on-demand purple dashed polygon |
| Plan | Underused parcels | amber fill |
| Plan | Conversion candidates | existing buildings extruded in grey; color by best use (residential blue, hotel purple, mixed use teal, keep = grey); opacity by overall score |
| Plan | Pursued sites | outline by deal strategy; label A/B/C |
| Plan | New buildings | extruded blue by height |

## Detail cards per agent

- **Infrastructure:** counts by kind; readiness histogram; click a parcel for present/gaps.
- **Transit:** routes with phase, headway, cost; measurement suggestions with expected narrowing.
- **Zoning & legislation:** per selected parcel, a row per legal path (eligible / not / not covered), what it allows, "§ cited" links, and the recommended path. In LA, show SB 79 and Adaptive Reuse side by side.
- **Site:** underused parcel count, top sites.
- **Building reuse:** ranked table (building, current use, best use, overall, units); click → radar or bar chart of the five fit scores, blockers list with the input and threshold behind each, and source badges (CoStar / Matterport / derived).
- **Land deal:** strategy tag per site, reasons, draft letter.
- **Funding:** capital stack bars; for parcels with both options, "New build vs Convert" comparison; pencils verdict; "Show math."
- **Sustainability:** target bars including embodied carbon saved.

## Provenance UI (required)

- Every number shows a badge: `CoStar · high`, `Matterport · high`, `derived · low`, `county records · medium`, `missing`.
- Hover a score or target → the factors behind it with values, sources and "unverified" marks.
- Click a citation → drawer with the corpus excerpt.

## State and performance

- One `plan` in context, updated by merging SSE payloads; re-score responses replace it and set `deltas`.
- Re-score requests debounced at 150 ms; total update under 1 s.
- Memoize deck.gl layers by data identity; building extrusions can be thousands of polygons.
