# CoStar field mapping

`TODO(kickoff)`: CoStar endpoint, auth, rate limits and the exact field names. Until confirmed, `CoStarProvider`
reads hand-entered fixtures (`backend/fixtures/<locale>/costar/*.json`) shaped like our schema. A real export
replaces those files with the same record shape: `{"id", "parcel_id"?, "fields": {<schema field>: {"value", "source_url", "note"}}}`.

| Schema field | CoStar field |
| --- | --- |
| `Parcel.area_acres` | unconfirmed — TODO(kickoff) |
| `Parcel.land_use` | unconfirmed — TODO(kickoff) |
| `Parcel.owner` | unconfirmed — TODO(kickoff) |
| `Parcel.last_sale_usd` | unconfirmed — TODO(kickoff) |
| `Parcel.last_sale_year` | unconfirmed — TODO(kickoff) |
| `Parcel.lease_expiry_year` | unconfirmed — TODO(kickoff) |
| `Parcel.address` | unconfirmed — TODO(kickoff) |
| `Parcel.assessed_value_usd` | unconfirmed — TODO(kickoff) |
| `Parcel.zoning_code` | unconfirmed — TODO(kickoff) |
| `Building.property_type` | unconfirmed — TODO(kickoff) |
| `Building.building_class` | unconfirmed — TODO(kickoff) |
| `Building.year_built` | unconfirmed — TODO(kickoff) |
| `Building.year_renovated` | unconfirmed — TODO(kickoff) |
| `Building.stories` | unconfirmed — TODO(kickoff) |
| `Building.rentable_area_sqft` | unconfirmed — TODO(kickoff) |
| `Building.typical_floor_sqft` | unconfirmed — TODO(kickoff) |
| `Building.vacancy_pct` | unconfirmed — TODO(kickoff) |
| `Building.asking_rent_usd_sqft_yr` | unconfirmed — TODO(kickoff) |
| `Building.parking_spaces` | unconfirmed — TODO(kickoff) |
| `Building.floor_depth_ft` | unconfirmed — TODO(kickoff) |
| `Building.ceiling_height_ft` | unconfirmed — TODO(kickoff) |
| `Building.window_wall_pct` | unconfirmed — TODO(kickoff) |
| `Building.roof_area_sqft` | unconfirmed — TODO(kickoff) |
| `Building.name` | unconfirmed — TODO(kickoff) |
