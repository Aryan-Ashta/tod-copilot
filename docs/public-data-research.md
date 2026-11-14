# Can free public data stand in for the CoStar / Matterport / Vexcel tier?

Researched 2026-11-14. Every dataset marked "probed" was queried live from this machine, and the field names below are the ones those queries returned. Anything not probed is marked [UNVERIFIED]. Throwaway probe scripts and outputs are in `/tmp/probe/` (`chi.py`, `chi_sample.json`, `cmbs.py`, `cmbs_props.json`, `hcad_bo.txt`).

## (a) Verdict

**Yes, partly.** Public data can fill about two-thirds of the `Building` checklist at medium confidence or better without inventing values. Three gaps remain everywhere:

- **Per-building observed vacancy and asking rent have no complete public source.** The usable stand-ins are:
  - (i) assessor income-model rent and vacancy. These are attached to each building but set by class × submarket, so they are really area averages.
  - (ii) Self-reported occupancy in energy benchmarking (NYC LL84, LA EBEWE).
  - (iii) **CMBS loan tapes on SEC EDGAR (EX-102)**, which give servicer-reported occupancy, revenue and the lease expiries of the 3 largest tenants per building. This is high quality but covers only buildings with a loan in a public securitization.
- **Ceiling height and window-wall %** have no public per-building source in any US city. Height ÷ stories gives floor-to-floor height at best (low).
- **Parking spaces** are not published per building in any candidate city (low/missing).

**Best location: Chicago Loop, the LaSalle Street corridor.**

- One Cook County Assessor table ([csik-bsws](https://datacatalog.cookcountyil.gov/Property-Taxation/Assessor-Commercial-Valuation-Data/csik-bsws)) gives, per office PIN, a **class-like investment rating (AA/A/B/C/D)**, year built, gross and **net rentable SF**, an assessor **market rent $/SF**, a **vacancy rate**, expense ratio, cap rate, NOI and market value.
- Illinois discloses sale prices, so [Cook parcel sales](https://datacatalog.cookcountyil.gov/resource/wvhk-k5uv.json) carry **price, buyer and seller**.
- [Chicago building footprints](https://data.cityofchicago.org/resource/syp8-uezg.json) carry **stories, year built and building name**.
- The city publishes six funded office-to-housing conversions with unit counts ([LaSalle Reimagined](https://www.chicago.gov/city/en/sites/lasalle-street/proposals.html)), so there are built-in backtests.
- The October 2026 CMBS tapes list 21 office or mixed-use properties in Loop ZIP codes with observed occupancy.

NYC Lower Manhattan is a close second. It has better building-specific occupancy and income (LL84 occupancy, DOF notice income), but **no public building class**, and the income figures have to be scraped from PDFs.

**AGENTS.md rule 6:** Chicago's "reuse engine on a high-vacancy office market" purpose overlaps Houston's, so it does not on its own justify a fourth locale. My recommendation:

1. Keep Houston and LA, switched to the public tier using HCAD / LA County data (tables in (c)). Houston's HCAD extract turned out richer than expected.
2. Add Chicago only if the team writes a new unique purpose into docs/11 first. One option: "public-data building reuse at medium confidence, backtested against six city-subsidized conversions, with a TIF funding path." The Cook parcel layer names the TIF district per parcel, e.g. `TIFDistrict = "TIF CITY OF CHICAGO - LASALLE CENTRAL"`.
3. Alternatively, Chicago replaces Houston as the main demo run. Houston's no-zoning legal path would then lose its CoStar data but keep working on the public tier.

The choice between 2 and 3 is a team decision.

---

## 1. Checklist: what CoStar, Matterport and Vexcel supplied

Taken from `backend/schemas.py`, `backend/data/costar_fields.md` and `docs/03-data-layer.md`.

| Capability | Field | Old provider |
| --- | --- | --- |
| BUILDING_ATTRS | `property_type`, `name`, `building_class` (A/B/C), `year_built`, `year_renovated`, `stories`, `rentable_area_sqft`, `typical_floor_sqft`, `parking_spaces`, `vacancy_pct`, `asking_rent_usd_sqft_yr` | CoStar |
| INTERIORS | `floor_depth_ft` (CoStar had none; derived), `ceiling_height_ft`, `window_wall_pct` | Matterport (ceiling only, scanned buildings only) |
| FOOTPRINTS / IMAGERY | `roof_area_sqft`, footprint geometry, surface-parking flag | Vexcel |
| PARCELS / OWNERSHIP_SALES | `Parcel.owner` (the CoStar kit had none; came from county), `last_sale_usd`, `last_sale_year`, `assessed_value_usd` | CoStar sale comps + county |
| LEASES | `Parcel.lease_expiry_year` | CoStar location-occupancy |

Confidence scale used below:

- **high**: a measured or recorded fact for this building.
- **medium**: an official estimate or attribute for this building.
- **low**: derived, area-level, or self-reported with heavy defaulting.
- **missing**: no source.

---

## 2. Sources that work in any US city

| Source | What it gives | Probe result | License |
| --- | --- | --- | --- |
| **SEC EDGAR ABS-EE EX-102 (CMBS asset tapes)**. Index: [form.idx 2026Q4](https://www.sec.gov/Archives/edgar/full-index/2026/QTR4/form.idx); sample: [Benchmark 2018-B4 exh_102.xml](https://www.sec.gov/Archives/edgar/data/1740849/000188852426020244/exh_102.xml) | Per property: `propertyName`, `propertyAddress`, `propertyZip`, `propertyTypeCode` (OF/MU/…), `netRentableSquareFeetNumber`, `yearBuiltNumber`, `yearLastRenovated`, `physicalOccupancySecuritizationPercentage`, **`mostRecentPhysicalOccupancyPercentage`**, `mostRecentRevenueAmount` (with `mostRecentFinancialsStartDate/EndDate`), `operatingExpensesAmount`, `mostRecentNetOperatingIncomeAmount`, **`largestTenant` / `squareFeetLargestTenantNumber` / `leaseExpirationLargestTenantDate`** and the same for the 2nd and 3rd tenants, `mostRecentValuationAmount` | Crawled all 351 CMBS ABS-EE filings from Oct 2026 (2,928 property rows in 7 cities). Office or mixed-use rows in the target cores: **Chicago Loop 21, NYC FiDi 24, Downtown Houston 6, Koreatown 3**. Examples: Aon Center occupancy 0.66 (was 0.879 at securitization); Heritage Plaza 0.768; Metroplex, 3530 Wilshire, 0.659 | US government filing, public |
| **REIT supplementals**, e.g. [SL Green 2026Q2](https://www.sec.gov/Archives/edgar/data/1040971/000162828026049346/a26q2supplemental.htm) | % leased and annualized cash rent per property, for that REIT's buildings only | Found by web search; the table was not parsed [UNVERIFIED column names] | Public filing |
| **Overture buildings**, `s3://overturemaps-us-west-2/release/2026-10-21.0/theme=buildings/type=building/` | `height`, `num_floors`, `names.primary`, `facade_material`, `roof_shape`, `class` (mostly OSM-sourced) | DuckDB query by bbox. Buildings over 50 m with `num_floors`: Loop 189/216, FiDi 74/163, Downtown Houston 49/70, Koreatown 18/34. **Warning:** the Field Building (135 S LaSalle) shows `height` 26.5 m, which is only the base part of the building | ODbL for OSM-derived rows [UNVERIFIED for this release] |
| **FEMA USA Structures**, [FeatureServer/0](https://services2.arcgis.com/FiaPA4ga0iQKduv3/arcgis/rest/services/USA_Structures_View/FeatureServer/0) | `HEIGHT`, `SQFEET`, `OCC_CLS`, `PRIM_OCC` | **Not usable downtown.** It lists 1000 Main St, Houston as `OCC_CLS = Industrial` with HEIGHT 86 m, and 1001 McKinney as "Education" with 44 m | Public domain [UNVERIFIED] |
| NAIP aerial imagery (0.6 m) and USGS 3DEP lidar | IMAGERY capability; heights from lidar | Not probed [UNVERIFIED]: https://naip-usdaonline.hub.arcgis.com/ and https://www.usgs.gov/3d-elevation-program | Public domain [UNVERIFIED] |
| Window-to-wall ratio | Research methods only (street-view computer vision), e.g. [Szcześniak et al. 2022](https://www.sciencedirect.com/science/article/pii/S0360132321005096) and [Akkoyun 2026](https://repositum.tuwien.at/bitstream/20.500.12708/229407/1/Akkoyun%20Yusuf%20-%202026%20-%20Automated%20Extraction%20of%20Window-to-Wall%20Ratio%20from%20Street...pdf). No published per-building US dataset was found | n/a | n/a |
| LoopNet / Crexi | The only broad source of asking rents per listing | Their terms of service prohibit scraping [UNVERIFIED: ToS text not re-read today]. **Do not use** | n/a |

Caveats on the CMBS tapes:

- **Revenue covers a partial period.** Aon Center's `mostRecentRevenueAmount` covers 2025-01-01 to 2025-09-30, so it must be annualized.
- **Different deals report different figures for the same building.** Aon Center shows revenue per SF of $22.84 in one deal and $31.18 in another. Treat revenue per SF as low confidence; occupancy and lease dates are the reliable fields.
- **Single-asset (SASB 144A) deals are not on EDGAR**, so some trophy towers are absent.

---

## (b) Ranked candidates

### 1. Chicago Loop / LaSalle corridor (winner)

| CoStar field | Public dataset → field (probed) | Granularity | Confidence |
| --- | --- | --- | --- |
| property_type | Cook valuation `property_type_use` (e.g. `Special-CBDOffice`) | building | high |
| name | Cook 2021 `property_name_description`; footprints `bldg_name1`; benchmarking `property_name`; Overture `names.primary` | building | medium |
| building_class | Cook `investmentrating`. Loop CBD offices in 2024: AA 12, A 93, B 74, C 18 | building (assessor rating) | medium. It is the assessor's rating, not CoStar's, and it moves: 135 S LaSalle was A in 2021 and C in 2024 |
| year_built | Cook `yearbuilt`; footprints `year_built`; benchmarking `year_built` | building | high. Sources sometimes disagree (1934 vs 1944 for 135 S LaSalle) |
| year_renovated | CMBS `yearLastRenovated` (subset); otherwise Chicago building permits [ydr8-5enu](https://data.cityofchicago.org/resource/ydr8-5enu.json) (not probed for this) | building | low / missing |
| stories | footprints `stories`; Cook 2021 `stories` (filled on 997 rows in the 2021 city townships) | building | high |
| rentable_area_sqft | Cook `netrentablesf` (and `bldgsf` gross); CMBS `netRentableSquareFeetNumber` | building | high (assessor) |
| typical_floor_sqft | footprint `shape_area`, or `bldgsf` ÷ stories | building, derived | medium-low |
| vacancy_pct | Cook `vacancy`. The CCAO says it uses **"market-level vacancy"** ([source](https://www.cookcountyassessoril.gov/south-chicago-commercial-valuations)); in 2024 the values are 0.10–0.27 by class and submarket. CMBS `mostRecentPhysicalOccupancyPercentage` where present | Cook: class × submarket. CMBS: building | Cook: low as a building value. CMBS: high (subset) |
| asking_rent_usd_sqft_yr | Cook `adj_rent_sf` (e.g. C 28.5, B 37.0, A 44.5–53.4, AA 55–60) | class × submarket | medium as a rent level, but not an asking rent |
| parking_spaces | Cook 2024 has no parking fields. The 2021 `parking` / `parkingsf` columns have 0 filled rows in the city. OSM `amenity=parking` + `capacity` [UNVERIFIED coverage] | n/a | missing / low |
| floor_depth_ft | Derived from the footprint (existing `DerivedInteriorProvider`) | building | low |
| ceiling_height_ft | Cook `ceilingheight` exists but has 0 rows for 2024 offices (2021: 378 rows, mostly industrial). Height ÷ stories, using Overture or Cook 2017 lidar [UNVERIFIED] | building, derived | low / missing |
| window_wall_pct | none | n/a | missing |
| roof_area_sqft | footprint `shape_area` | building | medium |
| Parcel.owner | Cook parcel addresses [3723-97qp](https://datacatalog.cookcountyil.gov/resource/3723-97qp.json) `owner_address_name`; also Cook 2021 `taxpayer` | parcel | medium-high |
| last_sale_usd / year | Cook parcel sales `sale_price`, `sale_date`, `buyer_name`, `seller_name`, `deed_type`, `is_multisale` | parcel | high (filter deed types and multi-parcel sales) |
| lease_expiry_year | CMBS top-3 tenant expiries | building, subset | high where present; otherwise missing |
| assessed value | Cook `finalmarketvalue` | parcel | high |
| zoning | [dj47-wfun](https://data.cityofchicago.org/resource/dj47-wfun.json) | polygon | high (not field-probed) |
| funding extra | Cook parcel polygons `TIFDistrict` | parcel | high |

License: the Cook County catalog metadata has no license field [UNVERIFIED terms]. The Chicago portal says "See Terms of Use".

### 2. NYC Lower Manhattan (FiDi)

| CoStar field | Public dataset → field (probed) | Confidence |
| --- | --- | --- |
| property_type | [PLUTO](https://data.cityofnewyork.us/resource/64uk-42ks.json) `bldgclass` (O1–O9 office), `landuse`, `officearea` / `retailarea` | high |
| name | [LL84](https://data.cityofnewyork.us/resource/5zyy-y8am.json) `property_name`; footprints `name` | medium |
| building_class | **none.** `bldgclass` is a use and height type, not A/B/C | missing |
| year_built / renovated | PLUTO `yearbuilt`, `yearalter1`, `yearalter2`; footprints `construction_year` | high / medium |
| stories | PLUTO `numfloors` | high |
| rentable_area | PLUTO `bldgarea` / `officearea` (gross); LL84 `office_gross_floor_area_ft` | medium (gross, not NRA) |
| typical_floor / floor depth | PLUTO `bldgfront` × `bldgdepth` (55 Broad: 131 × 216 ft) and footprint `shape_area` | medium / low |
| vacancy_pct | LL84 `occupancy`, self-reported in 5% steps. FiDi offices in 2024: 74 of 129 report 100. Also `office_worker_density_number` (55 Broad, 2022: 0.99 workers per 1,000 SF). CMBS for 24 FiDi properties | low-medium (building); CMBS high |
| asking_rent | DOF Notice of Property Value PDF: "Estimated Gross Income". 55 Broad, 2025: $20,213,256 on 406,025 GSF, about $49.8/SF ([NOPV](https://a836-edms.nyc.gov/dctm-rest/repositories/dofedmspts/StatementSearch?bbl=1000250001&stmtDate=20250115&stmtType=NPV)) | medium (DOF estimate per building; it is income, not asking rent) |
| parking | PLUTO `garagearea`; LL84 `parking_gross_floor_area`. FacDB [ji82-xba5](https://data.cityofnewyork.us/resource/ji82-xba5.json) `capacity` is 0 for licensed garages | low |
| ceiling | footprints `height_roof` ÷ `numfloors`. 55 Broad: 401.49 ft ÷ 30 = 13.4 ft floor-to-floor | low |
| windows | none | missing |
| roof area | footprints [5zhs-2jue](https://data.cityofnewyork.us/resource/5zhs-2jue.json) `shape_area` | high |
| owner / sales | PLUTO `ownername`; ACRIS [legals 8h5j-fqxa](https://data.cityofnewyork.us/resource/8h5j-fqxa.json) → [master bnx9-e6tj](https://data.cityofnewyork.us/resource/bnx9-e6tj.json) `document_amt`, `document_date` → [parties 636b-3b5g](https://data.cityofnewyork.us/resource/636b-3b5g.json). 55 Broad DEED 2023-07-28, $172,500,000, from 55 BROAD STREET L.P. to 55 BROAD STREET OWNER LLC | high |
| lease expiry | CMBS and REIT supplementals (SL Green, etc.) | subset |

Backtests: 55 Broad and 160 Water are already converted. PLUTO has 160 Water as D5 (elevator apartments) and 55 Broad still as O4.

### 3. Washington, DC (downtown)

| Field | Source → field (probed) | Confidence |
| --- | --- | --- |
| type / year / renovated | [CAMA Commercial](https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/FeatureServer/23) `USECODE`, `AYB`, `EYB`, `YR_RMDL` | high / medium |
| class | `GRADE` / `GRADE_D` (construction quality, e.g. "Very Good") | low |
| area | `LIVING_GBA` (gross) | medium |
| stories | **not in commercial CAMA**; use Overture | low-medium |
| ceiling | `WALL_HGT` (values 9–22) [UNVERIFIED that it means story height] | low |
| exterior wall | `EXTWALL_D` | — |
| owner / sale | [ITSPE](https://services.arcgis.com/neT9SoYxizqTHZPH/arcgis/rest/services/ITSPE_08172026/FeatureServer/0) `OWNERNAME`, `SALEPRICE`, `SALEDATE`; [sales layer 57](https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Property_and_Land_WebMercator/FeatureServer/57) `SALE_PRICE` | high |
| vacancy / rent | none ([benchmarking layer 45](https://maps2.dcgis.dc.gov/DCGIS/rest/services/DCGIS_DATA/Environment_Energy_WebMercator/FeatureServer/45) has no occupancy field); CMBS (36 DC office rows) | missing / subset |
| footprints | [Facility_and_Structure/1](https://maps2.dcgis.dc.gov/dcgis/rest/services/DCGIS_DATA/Facility_and_Structure/MapServer/1), no height | medium |

### 4. San Francisco (Financial District)

| Field | Source → field (probed) | Confidence |
| --- | --- | --- |
| type / year / stories / area | [Secured roll wv5m-vpq2](https://data.sf.gov/resource/wv5m-vpq2.json) `use_definition`, `year_property_built`, `number_of_stories`, `property_area`, `construction_type` | high |
| height | [Footprints ynuv-fyni](https://data.sf.gov/resource/ynuv-fyni.json) `hgt_median_m`, `hgt_maxcm` (2010 lidar) | medium |
| sale | `current_sales_date` only; no price (California) | medium (year) / missing (USD) |
| owner | not in roll | missing |
| vacancy | [Taxable Commercial Spaces rzkk-54yv](https://data.sf.gov/resource/rzkk-54yv.json) `vacant` YES/NO (ground-floor commercial vacancy tax only); CMBS 47 office rows | low / subset |
| benchmarking | [96ck-qcfe](https://data.sf.gov/resource/96ck-qcfe.json) `floor_area`, `property_type` (no occupancy) | — |
| class / rent / parking / ceiling / windows | none | missing |

### 5. Philadelphia (Center City)

| Field | Source → field (probed) | Confidence |
| --- | --- | --- |
| type / stories / year / area / quality | [OPA](https://phl.carto.com/api/v2/sql?q=SELECT%20*%20FROM%20opa_properties_public%20LIMIT%201) `building_code_description_new` ("OFFICE BLDNG - High Rise"), `number_stories`, `year_built`, `total_livable_area`, `quality_grade` (e.g. "C+") | high / low (grade) |
| owner / sale | `owner_1`, `sale_price`, `sale_date` (1801-21 Market sold 2025-10-22 for $30,000,000) | high |
| height | [LI_BUILDING_FOOTPRINTS](https://services.arcgis.com/fLeGjb7u4uXqeF9q/arcgis/rest/services/LI_BUILDING_FOOTPRINTS/FeatureServer/0) `approx_hgt`, `max_hgt` | medium |
| vacancy / rent | none; CMBS 13 office rows | missing / subset |

**Ranking rationale.** Only Chicago and NYC have building-level income or rent signals. Chicago also has a class rating and NRA in the same table. DC, SF and Philadelphia reach roughly the public tier Brevard already has, plus heights.

---

## (c) Public substitutes for the existing CoStar locales

### Houston downtown (HCAD bulk CAMA, probed)

Files: `https://download.hcad.org/data/CAMA/2026/Real_building_land.zip` (235 MB: `building_other.txt`, `exterior.txt`, `extra_features.txt`, `structural_elem1/2.txt`), `Code_description_real.zip`, `Real_acct_owner.zip`. Parcels: [HCAD Parcels MapServer/0](https://www.gis.hctx.net/arcgis/rest/services/HCAD/Parcels/MapServer/0).

Sample, One City Centre (acct 0011360000001), `building_other` building 1:

- `notes` "ONE CITY CENTRE …"
- `qa_cd` A (Excellent); `structure` A (Fireproofed Steel)
- `date_erected` 1962, `eff` 1988, `yr_remodel` 2026
- `im_sq_ft` 775,200; **`nra` 608,660**; `category` 04 (Office); **`tot_inc` 12,781,860** (about $21.0 per NRA SF)

From `structural_elem1`: physical condition Poor, functional utility Poor, exterior wall Glass / Masonry, LEED Gold, Energy Star.

From `exterior`: BAS 24,225 SF and BAU 750,975 SF. Building 2 is a parking garage with PGU 28,750 SF per level, and there is a 38,556 SF fire-proofed parking basement.

From the parcel layer: owner "1021 MAIN STREET OWNER LLC", `new_owner_date` 2025-02-10, `total_market_val` 20,411,265.

| Field | HCAD / public source | Confidence |
| --- | --- | --- |
| property_type | `building_other.category` / `pgi_dscr`, parcel `state_class` | high |
| name | `notes` free text (`prop_nm` is filled on only 2 office rows); Overture / OSM names | low-medium |
| building_class | `qa_cd` quality grade A–F. It is **not** market class; `structure` A/B/C is construction type, so do not use it as class | low |
| year_built / renovated | `date_erected` / `yr_remodel` | high / medium |
| stories | **none in HCAD.** The `STC` / `STY` / `WH` codes are defined but have 0 rows. Overture `num_floors` (49 of 70 tall buildings) | medium (Overture) |
| rentable_area | `nra` (filled on 1,954 of 2,083 office rows countywide) | high |
| typical_floor | `exterior` BAU area ÷ upper floors, or footprint | low-medium |
| vacancy | `occ_rt` is blank for offices (filled for apartments and hotels); CMBS covers Heritage Plaza 0.768, Total Plaza 0.813, Lyric Centre 0.806, 1001 McKinney 0.71, 2100 Travis 0.78 | missing / subset high |
| asking rent | `tot_inc` ÷ `nra` (Downtown Class A rows ≈ $23–26). Whether `tot_inc` is potential or effective gross income is [UNVERIFIED] | low |
| parking | parking subarea SF (`exterior` PGU; `extra_features` CBS4/CBS5/CPL1–8) → spaces via a factor | low |
| floor depth / ceiling / windows | footprint-derived / none / `XWC` exterior-wall type only | low / missing / missing |
| owner / sale | parcel `owner_name_1` (high); sale price missing (Texas is a non-disclosure state); `new_owner_date` gives the year (medium) | |
| lease expiry | CMBS top-3 tenants (subset) | |

**Verdict:** Houston can keep working without CoStar at mostly medium confidence. Rent is low and vacancy is missing except for the CMBS subset. The repo also has a hand-entered `research/buildings_source.yaml` sourced from the AECOM study.

### LA Wilshire / Koreatown (probed)

| Field | Source → field | Confidence |
| --- | --- | --- |
| property_type | [LA County parcel layer](https://public.gis.lacounty.gov/public/rest/services/LACounty_Cache/LACounty_Parcel/MapServer/0) `UseCode` / `UseDescription` ("Office Buildings") | high |
| name | none in the assessor layer; Overture / OSM | low-medium |
| building_class | `QualityClass1` (e.g. "AX", "BX", "AXA"); the decoding is [UNVERIFIED] | low |
| year_built / renovated | `YearBuilt1` / `EffectiveYear1` | high / low |
| stories | none in the assessor layer. [LARIAC 2020 outlines](https://services.arcgis.com/RmCCgQtiZLDCtblq/arcgis/rest/services/Countywide_Building_Outlines_(2020)/FeatureServer/0) `HEIGHT` (ft) ÷ an assumed floor height; Overture `num_floors` covers only 18 of 34 tall buildings | low |
| rentable_area | `SQFTmain1` (gross; e.g. 3435 Wilshire 777,581) | medium |
| typical_floor / roof | LARIAC `AREA`, `Shape__Area` | medium |
| vacancy | [EBEWE 9yda-i4ya](https://data.lacity.org/resource/9yda-i4ya.json) `occupancy`, self-reported (3255 Wilshire: 55; 3250 Wilshire: 90; 3200 Wilshire: 75). The `apn` field there is truncated, so join by address. CMBS: Metroplex, 3530 Wilshire, 0.659 | low-medium / subset high |
| asking rent | none (no public assessor income data in California) | missing |
| parking / ceiling / windows | none / LARIAC height ÷ stories / none | missing / low / missing |
| owner | no owner field in the parcel layer | missing |
| sale | `Roll_LandBaseYear` (Prop 13 base year); price not public in California | medium (year) / missing |

**Verdict:** LA works at the low-to-medium public tier. The legal comparison (SB 79 vs the Adaptive Reuse Ordinance) does not depend on CoStar, so LA's purpose survives.

---

## (d) Recording plan for the winner: Chicago LaSalle corridor

- **bbox suggestion:** `[-87.6400, 41.8750, -87.6240, 41.8870]`. It contains 437 Chicago footprints, 255 of them with 8 or more stories (probed with `within_box`). It covers all six LaSalle Reimagined buildings.
- **Locale settings:** `utm_epsg` 32616, `county_fips` 17031, transit agency CTA. Take station points from CTA GTFS; I did not invent coordinates.
- **Backtests** ([chicago.gov](https://www.chicago.gov/city/en/sites/lasalle-street/proposals.html)):

| Address | Units |
| --- | --- |
| 135 S LaSalle | 386 |
| 111 W Monroe | 345 |
| 30 N LaSalle | 349 |
| 105 W Adams | 400 |
| 208 S LaSalle | 168 |
| 79 W Monroe | 117 |

**Endpoints and confirmed fields:**

1. Cook commercial valuation: `https://datacatalog.cookcountyil.gov/resource/csik-bsws.json?$where=year='2024' AND property_type_use='Special-CBDOffice'`
   - Fields: `keypin`, `pins`, `address`, `property_type_use`, `investmentrating`, `yearbuilt`, `bldgsf`, `netrentablesf`, `adj_rent_sf`, `vacancy`, `exp`, `caprate`, `noi`, `finalmarketvalue`.
   - Also pull `year='2021'` for `stories` and `property_name_description`.
   - Join on `keypin`. The `address` strings are unreliable: "30 N LA SALLE" matched a hotel PIN.
2. Parcel polygons: `https://gis.cookcountyil.gov/traditional/rest/services/parcelHistorical/MapServer/2025` (`Name` = 14-digit PIN, `TIFDistrict`, `AssessorBLDGclass`). Points: `https://datacatalog.cookcountyil.gov/resource/nj4t-kc8j.json` (`lat`, `lon`).
3. Sales: `https://datacatalog.cookcountyil.gov/resource/wvhk-k5uv.json?pin=<14-digit>`. Fields: `sale_date`, `sale_price`, `seller_name`, `buyer_name`, `deed_type`, `is_multisale`, `num_parcels_sale`.
4. Owner: `https://datacatalog.cookcountyil.gov/resource/3723-97qp.json?pin=<14-digit>`. Fields: `owner_address_name`, `mail_address_name`.
5. Footprints: `https://data.cityofchicago.org/resource/syp8-uezg.json?$where=within_box(the_geom,41.8870,-87.6400,41.8750,-87.6240)`. Fields: `bldg_id`, `bldg_name1`, `stories`, `year_built`, `shape_area`, `the_geom`.
6. Benchmarking: `https://data.cityofchicago.org/resource/xq83-jr8c.json`. Fields: `property_name`, `address`, `primary_property_type`, `gross_floor_area_buildings_sq_ft`, `year_built`. No occupancy field.
7. CMBS: filter EX-102 by `propertyCity`='Chicago' and `propertyZip` in Loop ZIPs, using `mostRecentPhysicalOccupancyPercentage` and the three tenant lease-expiry fields. Script: `/tmp/probe/cmbs.py`, about 351 XML fetches, roughly 25 min at SEC's polite rate.
8. Zoning `dj47-wfun`, Overture heights, OSM / CTA GTFS: same as the other locales.

**Sample record pulled by the probe: 135 S LaSalle, PIN 17-16-211-009-0000**

```json
{"cook_valuation_2024": {"property_type_use":"Special-CBDOffice","investmentrating":"C","yearbuilt":"1934.0",
  "bldgsf":"1612954.0","netrentablesf":"1310047.0","adj_rent_sf":"28.5","vacancy":"0.23","exp":"0.4753",
  "caprate":"0.1","noi":"15084748.73","finalmarketvalue":"150847000"},
 "cook_valuation_2021": {"investmentrating":"A","yearbuilt":"1944.0","stories":"44.0","adj_rent_sf":"43.27",
  "property_name_description":"135 South LaSalle aka Bank of American Financial Center"},
 "footprint": {"bldg_id":"358297","bldg_name1":"BANK OF AMERICA","stories":"45","year_built":"1934","shape_area":"55253.375"},
 "sales": [{"sale_date":"2008-07-01","sale_price":"187500990","seller_name":"CNBC LEASING LLC","buyer_name":"135 S LASALLE PROP LLC","deed_type":"Warranty"}],
 "owner": {"year":"2025","owner_address_name":"135 S LASALLE PROP LLC"},
 "benchmarking_2023": {"property_name":"135 S LaSalle Property LLC","primary_property_type":"Office","gross_floor_area_buildings_sq_ft":"2453127","year_built":"1934"},
 "parcel_polygon": {"TIFDistrict":"TIF CITY OF CHICAGO - LASALLE CENTRAL","AssessorBLDGclass":"591"},
 "overture": {"names.primary":"Field Building","height":26.5,"num_floors":null}}
```

The Overture height of 26.5 m is wrong for a 44-story tower. Do not compute ceiling height from it.

**`Building` fields that stay missing or low in Chicago:**

| Field | Status |
| --- | --- |
| `window_wall_pct` | missing |
| `ceiling_height_ft` | missing; or low from lidar height ÷ stories |
| `parking_spaces` | missing / low |
| `floor_depth_ft` | low, footprint-derived (same as today) |
| `year_renovated` | low; CMBS subset only |
| `vacancy_pct` | low as a building-specific value (Cook is market-level); high only for CMBS-covered buildings |
| `asking_rent_usd_sqft_yr` | medium as an assessor market rent by class, not an observed asking rent |

**Code note:** the main agent would need a new provider. The schema needs no change, but provenance notes must say "assessor market-level vacancy for class C CBD office". No repo files were edited in this research.

---

## (e) Short answers to the specific questions

- **Any public per-building vacancy or asking rent?** Per-building occupancy: yes, for subsets. The CMBS EX-102 field `mostRecentPhysicalOccupancyPercentage` works nationally. REIT supplementals cover each REIT's own buildings. NYC LL84 and LA EBEWE have self-reported `occupancy`. Asking rent: no public per-building source. Closest proxies:
  - NYC DOF notice "Estimated Gross Income" per building.
  - Cook `adj_rent_sf` and HCAD `tot_inc` ÷ `nra` (assessor models).
  - CMBS revenue ÷ NRA.
- **Floor plate and depth from footprint + floors?** Floor plate: yes, at medium (footprint area, or gross area ÷ stories). Depth: low (geometry only, no core). NYC PLUTO `bldgdepth` is a recorded dimension, which is slightly better.
- **Ceiling height from lidar height ÷ floors?** Floor-to-floor height only, at low confidence. It fails on setback and podium buildings: the Field Building's Overture height covers only part of the building.
- **Windows?** No source. HCAD `XWC` "Glass / Masonry" and Overture `facade_material` are qualitative flags at most.
- **Parking?** Not per building anywhere I checked. NYC FacDB `capacity` = 0 for garages, Cook has no parking fields, and HCAD has parking SF only (convert with a factor). OSM is low.

---

## (f) Transit-poor candidates

Added 2026-11-14 after the user's follow-up: the Chicago Loop and Lower Manhattan already have strong transit, so they are poor targets for a TOD demo. The new criteria are: car-dependent, thin bus service, ideally a planned rail or BRT station or high office vacancy, and rich free building data. Harris and LA County sub-areas are preferred because the app already supports drawn areas there (AGENTS.md rule 6) and HCAD / LA County are already wired, so **no new locale or county is needed**. As before, "probed" means queried live today.

### Ranking

| # | Area | Transit need | Office vacancy | Data tier (public) | Locale cost |
| --- | --- | --- | --- | --- | --- |
| 1 | **Harris County: Westchase → Gulfton → Galleria/Uptown (southwest Houston)** | Westchase has park & ride and local buses only. In Gulfton, METRO proposes replacing circulators 309/310 with on-demand curb2curb. The **Gulfton BRT** (METRONext) is being prepared for a federal grant; its 2026 route is Gulfton → Galleria → Westheimer to downtown ([LINK Houston, 2026-06-22](https://linkhouston.org/gulfton-public-meeting/)) | Westchase 27.6%, Galleria/West Loop 31.6%, Class B Galleria 34.9% (Q3 2026, [Cresa](https://www.cresa.com/-/media/Cresa/Files/PDF-Market-Reports/Houston/2026/HOU-Q3-2026-Office-Market-Report.pdf)) | Same HCAD fields as downtown (probed below) + CMBS | Drawn area (already supported) or re-point the Houston locale |
| 2 | **LA County: Sherman Oaks / Van Nuys (Sepulveda Transit Corridor + East San Fernando Valley light rail)** | Car-dependent Valley. Sepulveda heavy rail locally preferred alternative selected Jan 2026 ([Metro](http://www.metro.net/about/media-relations/metro-boards-initial-approval-sets-stage-for-generational-transformation-of-sepulveda-pass-corridor)), with stations including Van Nuys/Metrolink, Sherman Way/Sepulveda, Sepulveda/G Line and Sepulveda/Ventura ([sepulvedatransit.com](https://www.sepulvedatransit.com/about)). East SFV light rail broke ground Oct 2026, 11 stations on Van Nuys Blvd, service projected 2032 ([LA Times](https://www.latimes.com/california/story/2026-10-20/east-san-fernando-valley-light-rail-line-gets-underway-five-years-behind-schedule)) | LA North 17.3% (area-wide, [Lee & Associates Q3 2026](https://www.lee-associates.com/wp-content/uploads/2026/10/2026-Q3-LA-North-CA-Office.pdf)); per-submarket figure [UNVERIFIED] | LA County assessor + LARIAC heights + EBEWE occupancy (all probed) | Drawn area (already supported) |
| 3 | **Harris County: Energy Corridor (I-10 West)** | Park & ride and local buses; no planned rail or BRT station found [UNVERIFIED: no plan located] | 21.4% (Class B 23.6%) ([Cresa](https://www.cresa.com/-/media/Cresa/Files/PDF-Market-Reports/Houston/2026/HOU-Q3-2026-Office-Market-Report.pdf)) | Same HCAD fields + 4 CMBS office properties | Drawn area |

**Best area outside Harris and LA: Columbus, OH.** It has the LinkUS West Broad BRT (9.3 mi, 17 stations, FTA Small Starts; [FTA profile](https://www.fta.dot.gov/sites/fta.dot.gov/files/2025-11/OH-Columbus-West-Broad-Street-BRT-Profile-AR26-11-19-25_0.pdf)). But its public data is weaker than Harris's. The [Franklin County parcel layer](https://gis.franklincountyohio.gov/hosting/rest/services/ParcelFeatures/Parcel_Features/MapServer/0) (probed) has `SALEPRICE`, `SALEDATE`, `OWNERNME1`, `BLDGAREA` and `CLASSDSCRP`. However, `FLOORCOUNT`, `GRADE` and `HEIGHT` are null on the large commercial parcels sampled, and there is no income or vacancy data. Columbus would also need a new county and locale.

Not pursued:
- Tysons/Reston, Denver Tech Center and Atlanta Perimeter already have rail.
- Dallas (DCAD) and Salt Lake suburbs: sale prices are not public (Texas and Utah are non-disclosure states) [UNVERIFIED for DCAD fields; not probed].
- Orange County office parks: no sale prices (Prop 13 state, no public price) [not probed].
- Cumberland (Cobb): no funded transit plan found [UNVERIFIED].

### 1. Harris County southwest: what the probes confirmed

HCAD bulk `building_other.txt` (2026) is filled for Galleria and Westchase offices exactly as it is downtown. I took the 40 largest F1 parcels in ZIPs 77042/77063/77056/77057 (from the HCAD parcel layer) and joined them to office rows (`category` 04). Probed samples:

| Address | `notes` (name) | `qa_cd` | `date_erected` | `nra` | `tot_inc` / `nra` |
| --- | --- | --- | --- | --- | --- |
| 1415 Post Oak | FOUR OAKS PLACE | A | 1983 | 1,769,562 | $24.74 |
| 5847 San Felipe | SAN FELIPE PLAZA | A | 1984 | 980,472 | $23.08 |
| 10777 Westheimer | ONE WESTCHASE CENTER | A | 1982 | 466,025 | $19.00 |
| 2000 Sam Houston | BRIARLAKE ONE | A | 1998 | 501,982 | $22.50 |
| 5599 San Felipe | SCHLUMBERGER SOLUTIONS | B | 1979 | 450,508 | $20.00 |

24 office matches in total.

CMBS EX-102 (Oct 2026 crawl), office and mixed-use rows with observed occupancy:
- **Galleria/Uptown, 5:** 4265 San Felipe 0.81; 5444 & 5430 Westheimer 0.43; 2700 Post Oak 0.781; 5051 Westheimer 0.681; 1500 Post Oak 1.0.
- **Westchase, 5:** 800 Wilcrest 0.91; 7670 Woodway 0.904; 9633 Westheimer 1.0; C&J Energy I and II.
- **Gulfton/SW Freeway, 1:** NOV HQ.
- **Energy Corridor, 4:** Chasewood Technology Park 0.69; West Memorial Place 0.79; Gray Falls Dr 0.79; Helios Plaza.
- **Greenspoint:** none.

Field coverage is the same as the Houston table in (c):

| Field | Confidence |
| --- | --- |
| property_type, rentable area (`nra`), year built, owner | high |
| stories (Overture `num_floors`) | medium |
| class (`qa_cd` quality, not market class), rent (`tot_inc` / `nra`, income type [UNVERIFIED]), parking SF→spaces, floor depth | low |
| vacancy | missing except for CMBS subset |
| sale price | missing (Texas is a non-disclosure state; `new_owner_date` gives the year) |
| ceiling height, windows | missing |

**Suggested area (approximate, parcel count not probed):**
- Westchase–Gulfton: `[-95.575, 29.700, -95.475, 29.745]`
- Galleria: `[-95.475, 29.725, -95.450, 29.760]`

Split the area if the recorder's 6,000-parcel cap applies, as it did for the downtown bbox.

**Rule 6:** a drawn area in Harris County is already allowed and needs no new locale. Making it the recorded Houston locale would replace downtown, but the no-zoning legal path still applies because Westchase, Gulfton and the Galleria are all inside the City of Houston.

### 2. Sherman Oaks / Van Nuys: what the probes confirmed

- **EBEWE** ([9yda-i4ya](https://data.lacity.org/resource/9yda-i4ya.json)), 2025, offices, self-reported `occupancy`: 15821 Ventura Blvd (453,805 SF) 65; 13400 Riverside Dr 70; 15503 Ventura 80; 15300 Ventura 90; 15165 Ventura 95; many others report 100. Sherman Oaks, Encino and Van Nuys are inside the City of LA, so EBEWE applies. Torrance and other non-city areas would lose it.
- **LA County parcel layer:** `UseCode` 17xx, `QualityClass1`, `YearBuilt1`, `SQFTmain1`, `Roll_LandBaseYear`. Example: 4727 Sepulveda Blvd, AX, 1981, 294,426 SF. Offices along Van Nuys Blvd itself are small (e.g. 6454 Van Nuys Blvd, 44,577 SF), so most building-reuse candidates sit near Ventura/Sepulveda in Sherman Oaks rather than along the light-rail line.
- **LARIAC 2020 outlines:** `HEIGHT` is present. 5 buildings over 150 ft in the Sherman Oaks Ventura/Sepulveda box (e.g. 308.83 ft, 244.51 ft).

| Field | Confidence |
| --- | --- |
| property_type, year built | high |
| gross area, roof area | medium |
| vacancy (EBEWE, self-reported) | low-medium |
| class (`QualityClass1`, [UNVERIFIED] decoding), stories (height ÷ assumed floor height), floor depth | low |
| asking rent, owner name, sale price, parking, windows | missing |
| CMBS | not crawled: the crawl filtered on `propertyCity`, and Valley properties report "Sherman Oaks"/"Van Nuys" [rerun `/tmp/probe/cmbs.py` with those cities] |

**Suggested area (approximate):** `[-118.475, 34.145, -118.440, 34.200]`, covering Sepulveda/Ventura north to the Van Nuys civic center. This area also shows the SB 79 vs Adaptive Reuse Ordinance question around a *planned* station [whether SB 79 counts planned Sepulveda stations: UNVERIFIED, check the corpus].

### 3. Energy Corridor

Same HCAD and CMBS sources as #1. It ranks third only because no planned station was found; its vacancy is lower than Westchase's and the Galleria's.
