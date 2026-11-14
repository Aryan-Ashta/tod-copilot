# 05: Models and math

Everything here is a pure function in `backend/models/`: plain data in, plain data out, no I/O (except cached provider calls made before modeling), no LLM. Each needs a unit test with a hand-checked example.

## Factor registry: `backend/data/factors.yaml`

Every constant lives here:

```yaml
reuse_max_floor_depth_ft_residential:
  value: null            # fill from the source; do not guess
  unit: ft (core to window)
  source_url: TODO
  verified: false
  note: deeper floors leave windowless interior space
```

Keys the code expects (all start `verified: false` until a human checks them):

| Key | Used by | Where to source it |
| --- | --- | --- |
| `reuse_max_floor_depth_ft_residential` | reuse | Conversion feasibility studies (e.g. Gensler's conversion scoring; trade press reporting window-to-corridor depths) |
| `reuse_min_ceiling_height_ft` | reuse | Same studies |
| `reuse_min_window_wall_pct` | reuse | Same studies |
| `reuse_floor_sqft_range_residential` | reuse | Same studies |
| `reuse_vacancy_threshold_pct` | reuse | Team choice, labeled |
| `conversion_cost_usd_per_sqft` | finance | Published conversion cost studies; by city if possible |
| `construction_cost_usd_per_unit` | finance | By city |
| `avg_unit_sqft_residential` | reuse, zoning | Market data (CoStar may provide in Houston/LA) |
| `rent_usd_per_unit_month` | finance | CoStar multifamily rents where available |
| `cap_rate`, `debt_ratio`, `interest_rate`, `vacancy_rate`, `opex_ratio` | finance | Label as assumptions |
| `houston_downtown_per_unit_incentive_usd` | finance | Past Downtown Living Initiative ($15,000/unit) as a reference; **status: program being shaped, verify** |
| `embodied_co2_kg_per_sqft_new` | targets | Embodied carbon databases (e.g. EC3) or published studies |
| `embodied_co2_kg_per_sqft_reuse` | targets | Same |
| `co2_g_per_vehicle_mile` | targets | EPA |
| `vmt_reduction_per_household_near_transit` | targets | Published research; record the study |
| `bus_operating_cost_usd_per_revenue_hour` | transit | National Transit Database |
| `walk_speed_m_per_s` | walk | Cite |
| `deal_vacancy_for_acquisition` | land deal | Team choice, labeled |
| `site_rank_weights`, `reuse_weights`, `readiness_weights` | site, reuse, infra | Team design choices, labeled |

If `verified` is false, the UI shows the value with an "unverified" mark. Verify every factor visible in the demo before judging.

## Building reuse (`models/reuse.py`)

For each building and each `UseType`, compute five fit scores in [0, 1]:

| Fit | Inputs | Method |
| --- | --- | --- |
| **Physical** | floor depth, typical floor size, ceiling height, window-wall %, stories, year built | Each input scored against its factor threshold with a soft ramp (1 inside the range, falling linearly to 0 over a tolerance band); combine with a weighted geometric mean so one failing input pulls the score down |
| **Legal** | `ZoningEnvelope` paths | 1 if an eligible path allows the use; 0.5 if covered but needs discretionary approval; 0 if prohibited; `None` → treat as 0.3 and add the blocker "legal status not covered by corpus" |
| **Market** | current vacancy, asking rent vs local residential rent | Higher vacancy and lower office rent relative to residential rent → higher score |
| **Financial** | acquisition basis (last sale or assessed), conversion cost, stabilized value | Preliminary pro forma margin mapped to [0, 1] |
| **Location** | `InfraReadiness.score`, walk access to amenities, distance to frequent transit | Weighted mean |

`overall = weighted mean (reuse_weights)`; `best_use = argmax overall` among uses, with `keep_current` winning if no use beats it by a margin factor. Every component score also returns the inputs and thresholds behind it, so the UI can explain it and blockers can be generated.

**Units:** `est_units = floor(rentable_area_sqft × efficiency_factor / avg_unit_sqft_residential)`, efficiency from factors.

**Backtests** (`tests/locales/`): run the scorer on the known Houston and LA conversions listed in `docs/11-test-locales.md`; they should score feasible and land within ±25% of the real unit counts.

## Infrastructure readiness (`models/infrastructure.py`)

For each target parcel/building:

- Distance (walk network) to: frequent transit stop, grocery, clinic, school, park.
- Street quality on frontages: share with sidewalks; bike lane within 400 m.
- Utilities: present / not present / data missing (missing never counts as absent).
- EV chargers and broadband availability.
- Flood zone: inside high-risk zone is a hard gap for new homes.

`score = weighted mean of normalized components (readiness_weights)`; `gaps` lists every component below its threshold in plain words.

## Transit network (`models/transit.py`)

1. Demand grid: aggregate homes, jobs, zero-car households to ~400 m hexes.
2. Candidates: corridors along major roads through high-demand hexes, plus feeders to stations.
3. Selection: maximize demand within 400 m of a stop subject to `sum(annual_operating_cost) ≤ budget` (greedy by demand per dollar; CP-SAT if time allows). Existing routes can be upgraded (frequency) as candidates.
4. Headways and costs from factors; phases 1–3.
5. Ridership range per stop: `demand_covered × [rate_low, rate_high]`.
6. `suggest_measurements`: rank stops by range width × demand; describe the measurement and the expected narrowing (assume a count shrinks the range to a fixed fraction, factor-labeled).

## Zoning (`models/zoning.py`)

`apply_rules` evaluates each path's structured rules (`corpus/rules/*.yaml`) for a parcel or building. `homes_for` = min(units allowed by density, floor area ÷ avg unit size). Uncovered → `None`.

## Finance (`models/finance.py`)

```
New build:   total_cost = land_cost + homes × construction_cost_usd_per_unit
Conversion:  total_cost = acquisition + rentable_area_sqft × conversion_cost_usd_per_sqft
noi          = units × rent × 12 × (1 - vacancy_rate - opex_ratio)
value        = noi / cap_rate
debt         = min(debt_ratio × total_cost, value × max_ltv)
incentive    = units × per_unit_incentive (only if the factor exists for the locale)
tax_credit   = affordable_units × per_unit_credit_equity
investor_eq  = target share × total_cost
gap          = total_cost - debt - incentive - tax_credit - investor_eq
pencils      = gap <= 0
compare_options: pick the option with the larger (value - total_cost); ties → conversion (less embodied carbon)
```

Return every intermediate number.

## Targets (`models/targets.py`)

- **Transport CO₂ avoided:** households near frequent transit × VMT reduction × g/mile ÷ 1e6.
- **Embodied carbon saved:** for each conversion, `area × (new − reuse)` kg CO₂e per sqft ÷ 1000.
- **Rooftop solar:** usable roof area → kW → annual MWh via PVWatts (cached).
- **Walk access:** share of new homes within 10 minutes of a park, clinic and grocery (precomputed distances).
- **Flood exposure:** share of new homes in FEMA high-risk zones; target 0.

## Re-score (`models/rescore.py`)

`rescore(plan, edits) -> (plan, deltas)` under 300 ms:

- `place_tile(homes, parcel)` → new-build site with cached envelope.
- `place_tile(park, parcel)` → open space; update homes, finance, walk access, CO₂.
- `place_tile(stop, parcel)` → add a stop; update coverage, walk, CO₂ (no full re-optimization).
- `place_tile(convert_residential|convert_hotel, building)` → force that use; recompute that building's units, finance, embodied carbon.
- `slider(v)` → trade homes for green space across pursued sites.

Precompute walk distances, envelopes, readiness and PVWatts when the plan is built.
