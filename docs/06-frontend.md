# 06: Frontend

Vite + React + TypeScript, MapLibre GL JS with deck.gl layers, Tailwind. Light paper-and-ink theme. One page, three screens.

## Screens

1. **Prompt (home):** a full-screen area map under the header, with the headline and a place search (any US county) floating top-left, the draw tools top-right, and one slim pill at the bottom: an area status dot, compact stock prompt chips, an icon-only Options button and Generate. There is no free-text prompt: the stock prompts for the area are multi-select chips (the first visible prompt is selected when the list changes). The selected prompts join into the request prompt and their options merge (focus = the common non-`all` focus, else `all`; each goal = the largest value set). The Options popover centred over the bar overrides the merged options: Focus (segmented control), a transit coverage goal slider (% of demand, resting on `transit_coverage_goal_pct`), three housing goal fields (new affordable homes, new homes total, buildings converted; blank = no goal), and Replay recorded run; Escape or a click outside closes it. "Generate" (or Enter, unless a field has the keyboard) starts the plan; the selected prompt ids travel as `?tags=<id,id>` and the plan header shows them as tag pills instead of the prompt text. On load the headline lines slide up, the blocks rise in and the map glides onto the lower 48 states. The map is held to the lower 48 and draws state lines (US Census Bureau; `frontend/public/geo/us-states.geojson`, built by `scripts/build_us_reference.py`). Houston and LA are pins; clicking one flies there and picks that recorded area (Brevard has no pin, so the home page cannot pick it). The map starts in pan mode; the draw tools are off by default: Freehand (traced as an open line while the button is held, closed into a polygon on release, as on Zillow), Rectangle (press, drag, release) and Polygon (click corners). Pressing the active draw button turns it off, and Clear removes the drawing and returns to pan. The status dot says what the selection will run as. Header note: "Concept · estimates, not legal or financial advice."
2. **Plan view (main):**
   - Left column (30% by default, resizable with a draggable divider, kept per browser): agent checklist (8 rows: pending / running / done / error), then a detail card for the selected agent. The agents run when the plan opens; their output (the cards) is the agents' suggestions and is not applied automatically.
   - Right: map, full height, with a layer toggle panel. The map, targets and scoreboard show existing conditions plus the user's edits. An emphasised "Apply agent suggestions" button (disabled while the agents run) adds an `apply_suggestions` edit, which builds the suggested sites and transit with the construction animations; it then turns into an "Agents' plan applied · Remove" pill. Selecting an agent in the checklist eases the camera to that agent's contributions, dims the other layers, overlays its contributions (ghost sites and routes, glowing candidates and so on) and shows a caption chip with counts and what they unlock (`src/agentFocus.ts`). For the Transit network agent, small 3D buses and multi-car trains run along the feed lines and proposed routes (proposed ones see-through until applied), clipped to the area, at most 150 vehicles, with more on frequent lines (`src/vehicles.ts`).
   - Bottom of the map: targets strip (bars side by side) and the homes ↔ green-space slider. The map frames the plan in the area the panels leave free, and card rows (sites, deals, conversion candidates, uncertainty items) fly the map to what they select.
3. **Meeting mode:** projector-friendly map with large type. Left panel (26% by default, same divider): the Apply agent suggestions button (until applied), "Plan history" and "Statistics" (see docs/07), and the homes ↔ green-space slider. A tile tray (Homes, Park, Stop, Convert to housing, Convert to hotel) sits on the map just above a bottom bar with homes, affordable homes, walk access, CO₂, embodied carbon saved and the funding required with animated deltas. Tiles are click-to-place: click a tile to arm it, then click a highlighted target. Pencil hints (`components/Hints.tsx`) draw a hand-drawn intro until the first change, then circle the new history row and the stats it moved. Edits persist per plan in `sessionStorage` (`transitor.edits.<planId>`), so the plan screen and meeting mode share them.

## Map layers (bottom → top), each toggleable

| Group | Layer | Style |
| --- | --- | --- |
| Base | Pale paper base map (`BASE_STYLE` in `components/MapView.tsx`): a static, label-free vector style on OpenFreeMap's keyless OpenMapTiles tiles (attribution: OpenFreeMap © OpenMapTiles, © OpenStreetMap contributors). CARTO raster tiles now need a key, so they are not used. The map canvas is antialiased | |
| Base | Aerial imagery | off by default |
| Infrastructure | Rail and bus routes (existing) | each line in its GTFS feed colour over a white casing (grey, black or pale feed colours fall back to ink for rail, mid blue for bus); rail bold in its true colour; bus thin, its colour lifted to mid lightness so dark navy does not read as a parcel or building outline; drawn above parcels and sidewalks, under buildings. Stops sized in metres (thin out when zoomed out) |
| Infrastructure | Sidewalks / bike lanes | thin lines; missing sidewalk frontages in amber |
| Infrastructure | Utilities (where public) | thin dashed lines; "not public here" note when missing |
| Infrastructure | EV chargers, schools, clinics, parks, grocery | small icons |
| Infrastructure | FEMA flood zones | blue hatch |
| Plan | Proposed routes and stops | frequent bus teal, BRT thick green under it, on-demand blue dashed polygon; stops on new or upgraded routes ringed teal |
| Plan | Underused parcels | amber fill |
| Plan | Conversion candidates | existing buildings extruded in grey; color by best use (residential blue, hotel purple, mixed use teal, keep = grey); opacity by overall score; a change of use fades to the new colour while conversion sites get a scaffold wrap that climbs the facade and comes down (2.8 s) |
| Plan | Pursued sites | outline by deal strategy; label A/B/C |
| Plan | New buildings | extruded blue by height for every site in the current view: solid = pencils, translucent = on watch. Each one is built (3.8 s, staggered 380 ms): a tower crane goes up (a second on big footprints; cranes that could cross stand at different heights, and plots sharing a spot share a crane) with its jib starting at a random angle and slewing round, floors rise with a springy overshoot inside scaffolding a storey ahead, then crane and scaffold are struck and a burst of confetti marks the finish. Existing buildings on the plot are demolished first (3 s: scaffold wrap, the building comes down storey by storey in dust) and the new build starts once the plot is clear. Random choices (jib angle and slew, tree size and lean, dust, confetti) come from a seed hashed from the footprint, so they hold steady between frames. Plays when suggested sites are applied, when a Homes tile is placed, and when the layer is switched on; with reduced motion only the end states show (`src/construction.ts`). With the green-space slider up, each in-plan (pursue or watch) new-build plot is split: share = slider × `slider_max_open_space_share`, the building keeps (1 − share) of the plot at its far side and the rest becomes lawn with trees and, when large enough, a fountain (`greenPlots` in `src/mapLayers.ts`, `parkDecorLayers` in `src/construction.ts`) |
| Plan | Proposed parks (meeting mode) | a Park tile on a parcel with buildings demolishes them first; the parcel then greens over and its 3D trees (bark trunk under two or three lit crown tiers, broadleaf or pine; seeded size and lean) pop up (2.2 s) and stay. Parks of 2,500 m² or more also build a fountain in the middle (basin, column with a bowl, spray arcs) |

Building edges are an ink edge layer instead of deck wireframes (`pushEdges`/`edgesLayer` in `src/mapLayers.ts`): roof and base outlines plus verticals at real corners only; footprints are simplified first, and footprints with more than 20 corners get outlines only.

## Detail cards per agent

- **Infrastructure:** counts by kind; readiness histogram; click a parcel for present/gaps.
- **Transit:** routes with phase, headway, cost (new and upgraded first, coloured as on the map); measurement suggestions with expected narrowing. Hovering or clicking a route row focuses it on the map.
- **Zoning & legislation:** per selected parcel, a row per legal path (eligible / not / not covered), what it allows, "§ cited" links, and the recommended path. In LA, show SB 79 and Adaptive Reuse side by side.
- **Site:** underused parcel count, top sites.
- **Building reuse:** ranked table (building, current use, best use, overall, units); click → radar or bar chart of the five fit scores, blockers list with the input and threshold behind each, and source badges (CoStar / Matterport / derived).
- **Land deal:** strategy tag per site, reasons, draft letter.
- **Funding:** goals table (target vs reached), the one-time housing funding required, yearly transit operating funding and the existing HUD LIHTC baseline; capital stack bars for funded and watch sites (reserve sites as a count); for parcels with both options, "New build vs Convert" comparison; "Show math."
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
