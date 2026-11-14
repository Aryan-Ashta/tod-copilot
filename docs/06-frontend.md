# 06: Frontend

Vite + React + TypeScript, MapLibre GL JS with deck.gl layers, Tailwind. Dark theme. One page, three screens.

## Screens

1. **Prompt:** three locale cards, each with its name, data tier badge (CoStar full / Public only) and its one-sentence purpose from `docs/11-test-locales.md`; clicking one scrolls to the map and flies to that area. The map is held to the lower 48 states and draws state lines (US Census Bureau; `frontend/public/geo/us-states.geojson`, built by `scripts/build_us_reference.py`). It shows each recorded area as a pin in its card's colour; areas are drawn freehand (traced as an open line while the button is held, closed into a polygon on release, as on Zillow), as a rectangle (press, drag, release) or as a polygon (click corners). A text box, Focus (segmented control), a transit coverage goal slider (% of demand, resting on `transit_coverage_goal_pct`), three housing goal fields (new affordable homes, new homes total, buildings converted; blank = no goal), and "Plan it." Header note: "Concept · estimates, not legal or financial advice."
2. **Plan view (main):**
   - Left column (30% by default, resizable with a draggable divider, kept per browser): agent checklist (8 rows: pending / running / done / error), then a detail card for the selected agent.
   - Right: map, full height, with a layer toggle panel.
   - Bottom of the map: targets strip (bars side by side) and the homes ↔ green-space slider. The map frames the plan in the area the panels leave free, and card rows (sites, deals, conversion candidates, uncertainty items) fly the map to what they select.
3. **Meeting mode:** projector-friendly map with large type. Left panel (26% by default, same divider): changes with Undo and Reset, targets, and the homes ↔ green-space slider. A tile tray (Homes, Park, Stop, Convert to housing, Convert to hotel) sits on the map just above a bottom bar with homes, affordable homes, walk access, CO₂, embodied carbon saved and the funding gap with animated deltas.

## Map layers (bottom → top), each toggleable

| Group | Layer | Style |
| --- | --- | --- |
| Base | Dark base map (`TODO(kickoff)`: tile provider key) | |
| Base | Aerial imagery | off by default |
| Infrastructure | Rail and bus routes (existing) | each line in its GTFS feed colour over a white casing (grey, black or pale feed colours fall back to ink for rail, slate for bus); rail bold, bus thin; drawn above parcels and sidewalks, under buildings. Stops sized in metres (thin out when zoomed out) |
| Infrastructure | Sidewalks / bike lanes | thin lines; missing sidewalk frontages in amber |
| Infrastructure | Utilities (where public) | thin dashed lines; "not public here" note when missing |
| Infrastructure | EV chargers, schools, clinics, parks, grocery | small icons |
| Infrastructure | FEMA flood zones | blue hatch |
| Plan | Proposed routes and stops | frequent bus teal, BRT thick green under it, on-demand blue dashed polygon; stops on new or upgraded routes ringed teal |
| Plan | Underused parcels | amber fill |
| Plan | Conversion candidates | existing buildings extruded in grey; color by best use (residential blue, hotel purple, mixed use teal, keep = grey); opacity by overall score; a change of use fades to the new colour (1.6 s) while conversion sites get a scaffold wrap that climbs the facade and comes down (3.4 s) |
| Plan | Pursued sites | outline by deal strategy; label A/B/C |
| Plan | New buildings | extruded blue by height for every site still in the plan: solid = pencils, translucent = on watch. Each one is built (4.6 s, staggered): a tower crane goes up (a second on big footprints; cranes that could cross stand at different heights, and plots sharing a spot share a crane), floors rise inside scaffolding a storey ahead, then crane and scaffold are struck. Existing buildings on the plot are demolished first (3.6 s: scaffold wrap, the building comes down storey by storey in dust) and the new build starts once the plot is clear. Plays when sites arrive in a live run or replay, when a Homes tile drops, and when the layer is switched on (`src/construction.ts`) |
| Plan | Proposed parks (meeting mode) | a Park tile on a parcel with buildings demolishes them first; the parcel then greens over and its trees pop up (2.6 s) and stay |

## Detail cards per agent

- **Infrastructure:** counts by kind; readiness histogram; click a parcel for present/gaps.
- **Transit:** routes with phase, headway, cost (new and upgraded first, coloured as on the map); measurement suggestions with expected narrowing. Hovering or clicking a route row focuses it on the map.
- **Zoning & legislation:** per selected parcel, a row per legal path (eligible / not / not covered), what it allows, "§ cited" links, and the recommended path. In LA, show SB 79 and Adaptive Reuse side by side.
- **Site:** underused parcel count, top sites.
- **Building reuse:** ranked table (building, current use, best use, overall, units); click → radar or bar chart of the five fit scores, blockers list with the input and threshold behind each, and source badges (CoStar / Matterport / derived).
- **Land deal:** strategy tag per site, reasons, draft letter.
- **Funding:** goals table (target vs reached), the one-time housing funding gap, yearly transit operating funding and the existing HUD LIHTC baseline; capital stack bars for funded and watch sites (reserve sites as a count); for parcels with both options, "New build vs Convert" comparison; "Show math."
- **Sustainability:** target bars including embodied carbon saved.

**Transit focus:** hovering a line or a stop on the map, hovering a row in the Transit card, clicking either, or selecting a stop focuses those routes (`TransitFocus`, keyed by `routeKey` in `src/mapLayers.ts`: the GTFS route id behind `rail-`/`bus-`/`upg-`/`brt-` ids). Focused lines widen and come to the top, their stops ring in the line colour, and the rest of the network fades. Clicking empty map clears it.

## Provenance UI (required)

- Every number shows a badge: `CoStar · high`, `Matterport · high`, `derived · low`, `county records · medium`, `missing`.
- Hover a score or target → the factors behind it with values, sources and "unverified" marks.
- Click a citation → drawer with the corpus excerpt.

## State and performance

- One `plan` in context, updated by merging SSE payloads; re-score responses replace it and set `deltas`.
- Re-score requests debounced at 150 ms; total update under 1 s.
- Memoize deck.gl layers by data identity; building extrusions can be thousands of polygons.
