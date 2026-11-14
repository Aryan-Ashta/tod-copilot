# 04: Agents

A coordinator (LangChain `deepagents`) runs eight sub-agents. Each has a narrow job, a fixed set of tools, and a Pydantic output type. Check the installed `deepagents` version's docs for how sub-agents and tools are declared; don't rely on memory of the API.

Order: Infrastructure → Transit network → Zoning & legislation → (Site ∥ Building reuse) → Land deal → Funding → Sustainability & health.

## Shared rules

- Output is a Pydantic object from `schemas.py`, validated before emitting. On failure, retry once, then emit `status: "error"` with the reason and continue.
- Tools do the work. The LLM chooses tools and writes short explanations. It never types a number into the output that did not come from a tool result.
- Emit SSE events at start, at each meaningful step, and at done.
- Handle `confidence="missing"` explicitly and say what's missing.
- Prompts live in `backend/agents/prompts/<agent>.md`.

## 1. Infrastructure agent

- **Goal:** show where infrastructure already is, and how ready each parcel or building is to take more people.
- **Tools:** `get_infra(locale, kinds)` (resolver: transit, streets, utilities, EV charging, broadband, amenities, flood), `readiness(targets, infra)` (pure, `models/infrastructure.py`).
- **Output:** `InfraFeature[]` for the map and `InfraReadiness[]` per candidate parcel/building with `present` and `gaps`.
- **Guardrails:** if a utility layer is missing for the locale, add the gap "utility data not public here; confirm with the utility," never "no utility service."

## 2. Transit network agent

- **Goal:** a phased network within an annual operating budget.
- **Tools:** `get_demand`, `get_existing_transit`, `optimize_network(demand, existing, budget)`, `estimate_ridership(stops, demand)`, `suggest_measurements(stops)` (all pure, `models/transit.py`).
- **Output:** `TransitPlan` with phases, headways, costs, and `measurements` ranked by how much each would narrow the ridership range.
- **Guardrails:** ridership is always a low–high range. Existing rail is kept. In Brevard, at least one change must improve an existing route's frequency.

## 3. Zoning and legislation agent

- **Goal:** for each candidate parcel, which legal paths apply and what each allows.
- **Tools:** `search_corpus(jurisdiction, query)`; `apply_rules(target, path_rules)` (pure, reads `corpus/rules/*.yaml`).
- **Output:** `ZoningEnvelope` per parcel with one `LegalPath` per regime, each with verbatim citations, and `recommended_path` chosen by comparing allowed units (ties → the path with fewer approval steps, from the rules file).
- **Per locale:**
  - Houston: "Houston development rules" path; no zoning districts; deed restrictions flagged as "check title."
  - LA: both "SB 79 new construction" and "LA Citywide Adaptive Reuse" paths evaluated for every eligible parcel.
  - Brevard: county/city land development code path.
- **Guardrails:** if the corpus doesn't cover a path, `eligible=None`. Never cite a section `search_corpus` didn't return.

## 4. Site agent (new construction)

- **Goal:** the best underused land near stops.
- **Tools:** `get_parcels`, `classify_land_use` (imagery flags), `find_combinable`, `homes_for(site, envelope)`.
- **Output:** `Site[]` with `kind="new_build"`.
- **Ranking:** homes × distance-to-stop weight × underuse score × infrastructure readiness. Weights in `factors.yaml`.

## 5. Building reuse agent

- **Goal:** for each existing building in the locale, which use it could become, and what stops it.
- **Tools:** `get_buildings(locale)` (BUILDING_ATTRS + INTERIORS + FOOTPRINTS), `score_reuse(building, envelope, readiness, market)` (pure, `models/reuse.py`), `estimate_units(building, use)`.
- **Output:** `ConversionCandidate[]` sorted by `overall`; the top ones also become `Site[]` with `kind="conversion"`.
- **Guardrails:**
  - Every blocker names the input and threshold that caused it: "floor depth 95 ft (Matterport) > 60 ft residential limit (factor `reuse_max_floor_depth_ft_residential`)."
  - When interiors are derived rather than scanned, say so and cap confidence at low.
  - In Brevard, only score what county data supports; label the result "screening only."
- **Competition with the Site agent:** when the same parcel appears in both, keep both options. The Funding agent decides which one to pursue.

## 6. Land deal agent

- **Goal:** a strategy per pursued site or conversion.
- **Decision rules (in code):**
  - Public agency owner → `joint_development`.
  - Conversion of an occupied building → `owner_partnership` unless vacancy > factor `deal_vacancy_for_acquisition`.
  - Same owner 20+ years → `ground_lease`.
  - Active leases running more than 3 years beyond today → `pass` (status `watch`).
  - Otherwise → `buy`.
  - Lease data missing → apply the other rules and add "lease status unknown, verify before outreach."
- **Output:** `DealStrategy[]` with letter drafts. Nothing is sent.

## 7. Funding agent

- **Goal:** does each candidate pencil, and which wins when a parcel has both a new-build and a conversion option?
- **Tools:** `pro_forma(site, deal, factors)`, `capital_stack(...)`, `compare_options(new_build, conversion)` (pure, `models/finance.py`).
- **Output:** `CapitalStack[]`; updates `Site.status`.
- **Rules:** conversions use conversion cost per sqft, not new construction cost per unit. Include a local incentive only if a factor for it exists, and show its "program status" note.

## 8. Sustainability and health agent

- **Tools:** `transport_co2`, `embodied_co2_saved` (reuse vs demolish-and-rebuild), `rooftop_solar`, `walk_access`, `flood_exposure` (pure, `models/targets.py`).
- **Output:** `TargetScore[]` with `factor_keys`.

## Coordinator

- Runs the order above; streams events; stores the `Plan` and the event log.
- If an agent errors, continue and mark that section as failed in the UI.
- Exposes `rescore(plan, edits)`, which never calls an LLM.
