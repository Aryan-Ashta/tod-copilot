# 01: Product spec

## One line

Type a place; get a map of the transit and infrastructure that already exist, the buildings that could be converted to other uses, the land that could be built on, what the law allows, how to get the land and pay for it, and scores for carbon and health. Anyone can then reshape the plan on screen and watch the trade-offs update.

## Users

- **City and transit planners:** draft a station-area plan in minutes, not months.
- **Developers and owners:** find which buildings convert and which sites pencil.
- **Residents at public meetings:** a projector-friendly "meeting mode" where they drag uses onto the map and see the results.

## Locales

Three, each with a distinct purpose. See `docs/11-test-locales.md` for the full rationale and validation tests.

| Locale | Data | Purpose |
| --- | --- | --- |
| Houston: Downtown + Main St rail | CoStar full | Building reuse on a high-vacancy office market; no-zoning legal path. Main demo |
| Los Angeles: Wilshire corridor, Koreatown | CoStar full | Overlapping laws: SB 79 new construction vs Citywide Adaptive Reuse Ordinance conversion |
| Brevard County, FL: Cocoa | Public only | Fallback with no CoStar data; car-dependent transit design; flood risk |

## Pipeline (eight agents)

1. **Infrastructure:** maps what already exists (transit, streets, sidewalks, bike lanes, utilities where public, EV chargers, broadband, schools, clinics, parks, grocery, flood zones) and scores each block's readiness.
2. **Transit network:** demand → routes, stops and frequency within an operating budget; phased (on-demand vans → frequent bus → BRT). Flags where ridership is least certain and what measurement would fix it.
3. **Zoning and legislation:** allowed height, units, parking and permitted conversions per parcel, with citations. Picks the better legal path when several apply.
4. **Site:** underused land (surface parking, one-story retail, vacant lots), combinable lots, homes per site.
5. **Building reuse:** for existing buildings, which other uses they could become (housing, hotel, mixed use, or keep), scored on physical, legal, market, financial and location fit, with the blocking issues listed.
6. **Land deal:** buy, ground lease, partner with the transit agency, or pass; draft owner letters.
7. **Funding:** pro forma and capital stack for both new construction and conversions; pencils yes/no.
8. **Sustainability and health:** transport CO₂, embodied carbon saved by reuse, rooftop solar, 10-minute walk access, flood exposure.

## Interactive planning (software only)

- **Meeting mode:** a large-type, touch-friendly view for a projector or tablet. Drag tiles (homes, park, stop, convert-to-housing) onto parcels or buildings; the plan re-scores in under a second.
- **Trade-off slider:** homes ↔ green space.
- **Uncertainty queue:** the plan lists the measurements that would most reduce its uncertainty (for example, a manual passenger count at the least-certain stop). Each one shows how much the range would narrow.

## Acceptance criteria

- [ ] One prompt per locale runs all eight agents end to end, streaming progress, in under 90 s live (or instantly from replay).
- [ ] The map shows existing infrastructure, routes, stops, conversion candidates, underused parcels, chosen sites, and 3D buildings for what is pursued.
- [ ] Every conversion candidate shows its best use, five fit scores, blocking issues and the source of each input.
- [ ] Every legal value shows a citation; clicking it shows the source text. In LA, parcels show which law path applies.
- [ ] Every data value shows a source and confidence badge.
- [ ] Each pursued site or conversion shows a capital stack and a pencils verdict, computed in code.
- [ ] Targets show transport CO₂, embodied carbon saved, solar and walk access, each with its factor source on hover.
- [ ] Meeting-mode drags and the slider re-score in under 1 s.
- [ ] The Brevard plan shows no CoStar data, medium or low confidence badges, missing-data notes, and 0% of new homes in flood zones.
- [ ] Each locale's validation checklist in `docs/11-test-locales.md` passes or has a written reason it's skipped.
- [ ] Everything works with `DEMO_OFFLINE=1`.
- [ ] A visible note says figures are estimates, not legal or financial advice.

## Out of scope

Hardware, accounts and login, saving projects, mobile layout, locales beyond the three above, real ridership forecasting models, and any write action against external systems (letters are drafts; nothing is sent).
