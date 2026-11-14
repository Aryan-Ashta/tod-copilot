# CoStar, Matterport and Vexcel field mapping

Source data: the CoStar HackPrinceton data kit (`cache/costar/`, from `/costar-keys` in the track Discord) and the
Matterport and Vexcel APIs with the team's keys (Doppler `tod-copilot` / `prd`). Recorded by
`doppler run -- uv run python scripts/record_fixtures.py --only costar,matterport,vexcel` into
`backend/fixtures/<locale>/{costar,matterport,vexcel}/`. All three are licensed for hackathon use only, so those
fixture folders are git-ignored.

Only non-housing CoStar properties inside the locale bbox are recorded (land, multifamily, residential and homes are
skipped: they are not building-reuse candidates). Each is linked to the largest OSM footprint within about 25 m of
its `primaryAddress` point, and to its county parcel through `parcelNumbers` (HCAD account as-is, LA AIN without
dashes), else spatially.

## Building (`costar/buildings.json`, source `costar`, confidence high)

| Schema field | CoStar field | Derivation |
| --- | --- | --- |
| `Building.property_type` | `propertyType` | Office → office, GeneralRetail → retail, Hospitality → hotel, Industrial and Flex → industrial, other types → other. A `constructionEvents` Converted event marks the building residential (already converted). |
| `Building.name` | `buildingName` | Street address when unnamed |
| `Building.building_class` | `buildingClass` | 1 A, 2 B, 3 C, 4 F |
| `Building.year_built` | `constructionEvents[eventType=2 ConstructionComplete].year` | earliest |
| `Building.year_renovated` | `constructionEvents[eventType=4 RenovationFinished].year` | latest |
| `Building.stories` | `numStoriesAboveGrade` | |
| `Building.rentable_area_sqft` | `rentableBuildingAreaSquareFeet` | |
| `Building.typical_floor_sqft` | `grossTypicalFloorSquareFeet` | |
| `Building.parking_spaces` | `parking[].totalSpaces` | sum |
| `Building.vacancy_pct` | location-occupancy | 100 × (RBA − SF occupied by current tenancies) / RBA. Current = no `toDate` and `fromDate` not in the future (leased-but-not-moved-in counts as vacant, per the kit). Overstates vacancy when a current tenancy records no area; the note says how many. |
| `Building.asking_rent_usd_sqft_yr` | commercial-listing-summary `forLeaseSummary.askingRateLow/High` | midpoint, per-SF listings only, monthly × 12, weighted by `totalAvailableSquareFeet`; service types (NNN, full service) are not normalized |
| `Building.floor_depth_ft`, `window_wall_pct` | none | not in the kit; still derived from the footprint or missing |

## Parcel (`costar/parcels.json`, `costar/leases.json`)

| Schema field | CoStar field | Derivation |
| --- | --- | --- |
| `Parcel.last_sale_year` | commercial-sale-comp `soldDate` | latest sale of the property; else the current owner contact's `startDate` |
| `Parcel.last_sale_usd` | commercial-sale-comp `soldForPrice` | single-property sales only; `entities[].allocatedPrice` for portfolios; missing when not disclosed |
| `Parcel.lease_expiry_year` | location-occupancy `leaseDeal.expirationDate` | SF-weighted median expiration of current leases that expire in the future; the note gives the coverage |
| `Parcel.owner` | none | owner contacts carry no company name in the kit; the county record is used |

## Matterport (`matterport/interiors.json`, source `matterport`, confidence high)

| Schema field | Model API field | Derivation |
| --- | --- | --- |
| `Building.ceiling_height_ft` | `model.rooms[].dimensionEstimates(units: imperial) { height area }` | floor-area-weighted median over every room with a single height estimate, across all scans of the property listed in `commercial-properties.csv`. Scans cover only some floors and suites. |

## Vexcel (`vexcel/*.json`, source `vexcel`, confidence high)

Queried with `GET /property/extract` at each non-residential county parcel's interior point. Brevard is outside the
key's geofence (403), so it stays on public imagery and footprints.

| Schema field | Vexcel field | Derivation |
| --- | --- | --- |
| `Building.roof_area_sqft`, footprint geometry | `structures[].footprint.area`, `footprint.wkt` | attached to the OSM building containing the structure footprint's interior point |
| surface-parking flag (IMAGERY) | `structure.count`, `hardscapes.percent` | no structure and at least factor `vexcel_surface_parking_hardscape_min_pct` hardscape |
