# Factor verification (2026-11-14)

Scope: the 45 factors the demo surfaces (`FactorHover` keys in the Targets bars, meeting-mode Scoreboard, Funding card,
Building reuse blockers and score inputs, plus the `factor_keys` / `assumptions` the backend attaches to targets,
capital stacks, gap-to-pencil and score inputs in the three demo plans). 28 cite an external source and were checked
against it; 17 are labelled team design choices with no external source.

Verdicts: **matches** (value stated in the source), **derived correctly** (source numbers + the note's arithmetic give
the value), **mismatch**, **source unreachable**. Every flag in `factors.yaml` is still `verified: false`; flags change
only for keys the team approves.

## Externally sourced (28)

| key | value | unit | source | where it appears | verdict | comment |
|---|---|---|---|---|---|---|
| rent_usd_per_unit_month | HOU 2288 · LA 2218 · BRE 1757 | USD/unit/month | rentcafe.com average rent pages | quotes in note ("The average rent for an apartment in Downtown Houston is $2,288") | source unreachable | All three pages return 403; no Wayback snapshots. |
| cap_rate | 0.0525 | fraction | CBRE U.S. Cap Rate Survey H1 2026 (PDF via 1031buyerrep.com) | p.11 Multifamily Infill Class A: Houston 5%–5.25%, LA 4.75%–5.5%, Orlando 4.75%–5.5% | **mismatch** | Range midpoints are 5.125% each, so the "midpoint across the three markets" is **0.05125**; 0.0525 is Houston's top. |
| debt_ratio | 0.87 | fraction of cost | hud.gov Mortgagee Letter 2025-03 | p.2 table, Market Rate "221(d)(4) NC/SR 85% 87%" | matches | |
| interest_rate | 0.0705 | fraction/yr | skylatus.com Multifamily Loan Rates 2026 | "HUD / FHA 221(d)(4) ~6.8% – 7.3% before MIP" | derived correctly | (6.8 + 7.3) / 2 = 7.05%. |
| max_ltv | 0.80 | fraction of value | skylatus.com Multifamily Loan Rates 2026 | Agency fixed: "Up to 80% LTV" | matches | |
| vacancy_rate | 0.0615 | fraction | naahq.org (NAA Income/Expense IQ 2024) | "Vacancy and rent loss rose again to $1,323 per unit"; rent $21,502 | derived correctly | 1,323 / 21,502 = 0.0615. |
| opex_ratio | 0.4026 | fraction of rent | naahq.org (NAA Income/Expense IQ 2024) | "total annual operating expenses per unit climbed to $8,657 per unit" | derived correctly | 8,657 / 21,502 = 0.4026. |
| construction_cost_usd_per_unit (HOU) | 327,500 | USD/unit | Newmark Houston Multifamily 4Q25 | p.36 Replacement Cost Tracker, Mid-Rise Concrete Podium: hard "$240K – $295K", soft "$45K - $75K" | derived correctly | 267,500 + 60,000. Land excluded. |
| construction_cost_usd_per_unit (LA) | 429,996 | USD/unit | RAND RR-A3743-1 Table 3.3 + RLB QCR Q3 2020 / Q4 2025 | hard $259 + soft $86 per NRSF (2019 $); RLB LA Oct 2019 21,819, Oct 2025 29,884 | derived correctly | 313,950 × 29,884/21,819 = 429,996. Note's rounded "1.3696" gives 429,986: note wording only. |
| construction_cost_usd_per_unit (BRE) | 190,517 | USD/unit | Census Building Permits Survey 2025 (co2025a.txt) | Brevard 12009, 5+ units: 1,230 units, $234,335,714 | derived correctly | Permit value; understates cost (noted). |
| conversion_cost_usd_per_sqft (HOU) | 360 | USD/sqft | AECOM Downtown Houston Office Conversion Study (ctycms.com mirror) | "Average conversion cost was in the ballpark of $360 per square foot" | matches | centercityphila.org URL is Cloudflare-blocked; mirror used. |
| conversion_cost_usd_per_sqft (LA) | 434 | USD/sqft | HR&A Exhibit F.4, cityclerk.lacity.org | 533 S Fremont Ave: Total Development Costs per GBA $434 | matches | |
| conversion_cost_usd_per_sqft (BRE) | 238 | USD/sqft | HR&A Orlando Empire Building case | p.41: hard $8.6M, soft $2.1M, financing $0.7M; 47,800 rentable sf | derived correctly | 11.4M / 47,800 = 238.5. |
| per_unit_credit_equity_usd (HOU) | 91,668 | USD/affordable unit | TDHCA Item 31 + CohnReznick price via lihtc.loans | "more than $69M … 6,050 total units"; "4,185 units and over $45 million"; "$0.823" | derived correctly | Lower bound (note says so). |
| per_unit_credit_equity_usd (LA) | 200,533 | USD/affordable unit | lihtcsanitycheck.com CA benchmarks 2026 | median "Federal tax credit equity per unit", 4% awarded | matches | Recomputed from the site's data file. |
| per_unit_credit_equity_usd (BRE) | 133,256 | USD/affordable unit | FHFC 2025 Annual Report | "$167,954,503 in non-competitive (4%) Housing Credits"; "10,373 units" | derived correctly | |
| houston_downtown_per_unit_incentive_usd | 15,000 | USD/unit | therealdeal.com (Jan 2024) | "offers up to $15,000 per unit in tax rebates to developers" | matches | "Up to": a maximum. |
| affordable_rent_usd_per_unit_month (HOU) | 1,137 | USD/unit/month | westmontadvisors.com 2025 LIHTC limits, Harris County | 1-person $42,480, 2-person $48,540 at 60% | derived correctly | Not cross-read against TDHCA's rent table. |
| affordable_rent_usd_per_unit_month (LA) | 1,704 | USD/unit/month | westmontadvisors.com 2025 LIHTC limits, LA County | 1-person $63,600, 2-person $72,720 at 60% | derived correctly | Not cross-read against CTCAC's table. |
| affordable_rent_usd_per_unit_month (BRE) | 1,125 | USD/unit/month | Florida Housing 2025 Income and Rent Limits | 60% row, rent "1,050 / 1,125 / 1,350" (0/1/2 BR) | matches | |
| avg_unit_sqft_residential | 910 | sqft/unit | rentcafe.com blog (Aug 2026) | "reaching 910 square feet" | matches | Covers all apartments in 50+ unit buildings, not only new ones as the note says. |
| co2_g_per_vehicle_mile | 400 | g CO2/mile | epa.gov typical passenger vehicle | "emits about 400 grams of CO2 per mile" | matches | |
| embodied_co2_kg_per_sqft_new | 28.8 | kg CO2e/sqft | CLF Embodied Carbon Benchmark Report 2025 | Table 1, Multifamily 50th pct, A1-A3 = 310 kgCO2e/m² | derived correctly | 310 / 10.764 = 28.8. |
| embodied_co2_kg_per_sqft_reuse | 10.94 | kg CO2e/sqft | builtbuildings.org (ULI / Architecture 2030) | "62% … embodied carbon avoided through housing created by conversions" | derived correctly | 28.8 × 0.38. |
| vmt_reduction_per_household_near_transit | HOU/LA 1884 · BRE 869 | miles/household/yr | CARB brief (2025) + FHWA 2022 Summary of Travel Trends | "(13% versus 6% reduction in VMT)"; Table 3-4 2022 = 14,489 | derived correctly | 0.13 / 0.06 × 14,489. |
| solar_kw_per_m2 | 0.16 | kW/m² | NREL/TP-6A20-65298 | Table 1 "Module power density 160 W/m2" | matches | |
| solar_kwh_per_kw_year | HOU 1421.4 · LA 1678.3 · BRE 1543.1 | kWh/kW/yr | NREL PVWatts v8 API (developer.nlr.gov) | ac_annual with the note's parameters | matches | Re-queried 2026-11-14 with the project key: 1421.42, 1678.35, 1543.08 (v8.5.0). |
| usable_roof_share | 0.42 | fraction | NREL/TP-6A20-65298 | "60%–65% of commercial rooftop area"; flat-roof module ratio "0.7" | derived correctly | 0.60 × 0.70. |
| walk_speed_m_per_s | 1.067 | m/s | MUTCD 2009 Part 4E | "a walking speed of 3.5 feet per second" | derived correctly | 3.5 × 0.3048. |
| reuse_efficiency_factor | 0.75 | net/gross | NYC Comptroller (2025) | "the rentable-to-gross square feet ratio is 75%" | matches | |
| reuse_floor_sqft_range_residential | [12000, 20000] | sqft/floor | Gensler for SPUR (2023) | p.10 "High Rise 12001 - 20000 sf"; p.12 "mid-size floorplates scored the highest" | matches | Note's "averaged 84%" is not in the PDF (row shows 80/84/81/85%): reword the note. |
| reuse_max_floor_depth_ft_hotel | 36 | ft | gensler.com office-to-hotel blog | "32-36 feet from the building core to the exterior wall" | matches | |
| reuse_max_floor_depth_ft_residential | 45 | ft | Gensler Saint Paul study (ctycms.com) | "Ideal depth is 35'-0"-45'-0"" | matches | |
| reuse_max_floor_depth_ft_mixed_use | 45 | ft | Gensler Saint Paul study | same residential range | derived correctly | No mixed-use figure published; note says so. |
| reuse_min_ceiling_height_ft | 7.5 | ft | IBC 2024 §1208.2 (codes.iccsafe.org) | not viewed | source unreachable | HTTP 403, no mirror found. |
| reuse_min_window_wall_pct | 30 | % of facade | IBC 2024 §1204.2 (codes.iccsafe.org) | not viewed | source unreachable | HTTP 403. Arithmetic 0.08 × 45 / 12 = 0.30 checks. |

## Team design choices (17): no external source to check

`affordable_share`, `investor_equity_share`, `newbuild_assumed_stories`, `site_lot_coverage_ratio`,
`walk_minutes_target`, `walk_detour_factor`, `slider_max_open_space_share`, `reuse_feasible_threshold`,
`reuse_fin_margin_ceiling`, `reuse_keep_margin`, `reuse_location_weights`, `reuse_physical_weights`, `reuse_weights`,
`reuse_min_building_age_years`, `reuse_min_stories`, `reuse_missing_input_score`, `reuse_vacancy_threshold_pct`.
Their `source_url` is "team choice". "Verified" for these can only mean the team confirms the choice.

## Summary

- matches or derived correctly: 24 of the 28 sourced keys (every locale of each)
- mismatch: `cap_rate` (correct per its own note: 0.05125)
- source unreachable: `rent_usd_per_unit_month` (RentCafe 403), `reuse_min_ceiling_height_ft`, `reuse_min_window_wall_pct` (ICC 403)
- note wording to fix without a value change: `reuse_floor_sqft_range_residential` (84% claim), LA `construction_cost_usd_per_unit` (rounded ratio)

## Sign-off (2026-11-14)

- `verified: true`: the 24 sourced keys that match or derive correctly, the 17 team design choices (confirmed as
  choices by the team), and `cap_rate` after the correction below.
- `cap_rate`: value changed 0.0525 → 0.05125 (approved); demo plans re-precomputed.
- Notes reworded, values unchanged: `reuse_floor_sqft_range_residential`, LA `construction_cost_usd_per_unit`.
- Still `verified: false`: `rent_usd_per_unit_month` (RentCafe 403), `reuse_min_ceiling_height_ft`,
  `reuse_min_window_wall_pct` (ICC 403).
