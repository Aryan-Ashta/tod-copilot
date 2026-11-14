# 12: Agent research (filling building and market data where CoStar has none)

Status: **built** (build-order steps 1-4 and 6-7 in code; step 5 started: real runs on 1 Brevard and 3 Houston jobs, output in `agent_research/` awaiting human review). Originally a handoff spec; read `AGENTS.md`, `docs/02-architecture.md`, `docs/03-data-layer.md` and `docs/04-agents.md` first. Where this spec and those docs conflict, they win. How the build differs from the text below is in §14.

## 1. Problem

The building reuse engine needs building attributes that only CoStar supplies systematically. Field coverage on candidate buildings, measured 2026-11-14 with `DEMO_OFFLINE=1` (`common.candidate_buildings`):

| Field | Houston (142) | LA (413) | Brevard (228) |
|---|---|---|---|
| any CoStar value | 17 | 2 | 0 |
| `vacancy_pct` | 21 | 4 | 0 |
| `asking_rent_usd_sqft_yr` | 19 | 1 | 0 |
| `parking_spaces` | 21 | 3 | 0 |
| `building_class` | 30 | 7 | 0 |
| `year_built` | 30 | 320 (county) | 0 |
| parcel `last_sale_usd` | 9 / 4,977 | 1 / 4,935 | 0 / 5,246 |

So the gap is not only "public-tier locales." It covers most buildings in every locale, and every drawn area (`cache/areas/<id>/`). Today the only thing that fills it is `fixtures/<locale>/research/buildings_source.yaml`: values entered by hand, each with a URL and quote (13 Houston buildings, 6 LA). The missing market fields fall back to `reuse_missing_input_score`, so rankings are driven by whichever buildings happen to have data.

**Goal:** a LangChain `deepagents` research pipeline that does what the hand research does, for any supported locale or drawn area. It finds cited public facts for the buildings where a fact would most change the plan, verifies every fact in code, and records them as fixtures with provenance.

## 2. Non-goals and hard limits

- **No LLM at plan time.** Research runs while recording (`record_fixtures.py`, or area recording in `backend/data/areas.py`). `run_plan` only reads recorded fixtures. The offline demo stays unchanged (ground rule 7).
- **The LLM never estimates a value.** It finds and quotes. A value enters the data layer only if code can find the quote in the cached source and parse the number out of that quote (ground rules 1 and 4). A fact that is not found stays `missing`.
- **No CoStar-owned sites** (LoopNet, CoStar.com, Apartments.com, Homes.com, LandsOfAmerica, Ten-X). Scraping them would undercut the CoStar extract terms. Put them in the global denylist (§6).
- **No legal claims.** Zoning and legal paths stay with `backend/corpus/` (ground rule 3). The research agent does not touch the corpus.
- **No new endpoints invented.** The search provider is `TODO(kickoff)` (§9). Build it behind an interface with a fixture-backed fake.
- **No locale ids in code.** Everything locale-specific comes from the `Locale` object and config files (§6).

## 3. Architecture

```
record_fixtures.py --only agent_research --locale <id>      (or areas.record_area step "agent_research")
        │
        ▼
  gap queue (pure, models/research.py)  ──►  top-N (building, field) jobs, ranked by score swing
        │
        ▼
  deepagents coordinator (backend/research/agent.py)
        ├─ task → building_researcher subagent  (one per building; isolated context)
        │     tools: web_search, fetch_page (cached), read/grep saved pages, submit_facts
        │     skills: one per source type (assessor card, brokerage report, press, city filing, …)
        │     response_format: ResearchedBuilding
        └─ task → market_researcher subagent    (one per locale; submarket vacancy/rent)
              response_format: ResearchedFactor
        │
        ▼
  verifier (pure + cache reads, backend/research/verify.py)   ── rejects ──► research_rejects.jsonl
        │ accepted
        ▼
  <locale_dir>/agent_research/buildings_source.yaml   (same shape as research/buildings_source.yaml)
        │ existing linker (record.py Linker), extended
        ▼
  <locale_dir>/agent_research/{buildings,parcels}.json + _meta.json
        │
        ▼
  AgentResearchProvider (resolver, after PublicResearchProvider, before CountyParcelProvider)
```

Market facts (§5.3) go to `backend/data/factors.yaml` as `verified: false` proposals, never straight into the resolver.

## 4. Files to add or change

| File | Change |
|---|---|
| `backend/schemas.py` | Add `ResearchedFact`, `ResearchedBuilding`, `ResearchedFactor`, `ResearchJob` (§5). Mirror in `frontend/src/types.ts` only if the UI shows them (it doesn't need to at first). |
| `backend/models/research.py` | New, pure: `research_queue(buildings, parcels, conversions, f) -> list[ResearchJob]` (§5.1). |
| `backend/research/agent.py` | New: builds the deep agent, runs it over the queue, returns `ResearchedBuilding[]` and `ResearchedFactor[]`. |
| `backend/research/tools.py` | New: `web_search`, `fetch_page`, `submit_facts`. All HTTP goes through `backend/data/http_cache.py`. |
| `backend/research/verify.py` | New: `verify_fact(fact, field_spec, building, f) -> Accepted \| Rejected` (§7). |
| `backend/research/fields.yaml` | New: the field registry (§6.1). |
| `backend/research/sources.yaml` | New: the source registry and policies by state and jurisdiction (§6.2). |
| `backend/research/skills/<source-type>/SKILL.md` | New: one skill per source type (§6.3). |
| `backend/research/prompts/{coordinator,building_researcher,market_researcher}.md` | New prompts. |
| `backend/data/providers/agent_research.py` | New: `AgentResearchProvider(FixtureRecordProvider)`, `name="agent_research"`, `folder="agent_research"`, confidence from each fact's record (default `low`). |
| `backend/data/resolver.py` | Insert `AgentResearchProvider()` right after `PublicResearchProvider()` in `default_resolver()`. |
| `backend/data/record.py` | Add `record_agent_research(lid)` to `STEPS`. Generalize `record_research` into a `link_research(lid, folder)` that both steps share. |
| `backend/data/areas.py` | Add `"agent_research"` to `METRO_STEPS` **last**, behind a flag (§8.2). |
| `backend/data/factors.yaml` | Only through the market researcher's proposals: `verified: false` (ground rule 2). Also add every new threshold this spec needs (§5.1, §7) with `verified: false`. |
| `backend/tests/test_research_*.py` | New (§10). |

## 5. Data contracts

```python
class ResearchedFact(BaseModel):
    field: str                      # a key in research/fields.yaml, e.g. "vacancy_pct"
    value: float | int | str        # what the LLM read; the verifier re-derives it and the two must match
    source_url: str
    quote: str                      # verbatim span from the page, 20-400 chars, containing the value
    as_of: Optional[str] = None     # date or quarter the source says the value applies to ("Q3 2026")
    page: Optional[int] = None      # PDF page, when the source is a PDF

class ResearchedBuilding(BaseModel):
    job_id: str
    building_id: str                # from the queue; the agent never makes one up
    name: Optional[ResearchedFact] = None
    address: Optional[ResearchedFact] = None
    facts: list[ResearchedFact]     # empty is a valid answer
    not_found: list[str]            # fields searched for and not found, with no guesses

class ResearchedFactor(BaseModel):
    factor_key: str                 # an existing or proposed factors.yaml key
    scope: str                      # locale id or submarket name the value applies to
    fact: ResearchedFact

class ResearchJob(BaseModel):
    job_id: str
    building_id: str
    parcel_id: Optional[str]
    label: str                      # common.building_label(); what the agent searches for
    address: Optional[str]
    lonlat: tuple[float, float]
    fields: list[str]               # missing fields worth researching, best first
    swing: float                    # max change in ConversionCandidate.overall if those fields were known
```

### 5.1 Gap queue (pure, deterministic)

`research_queue` chooses what to research. The LLM does not.

1. For each candidate building (`common.candidate_buildings`), list the `fields.yaml` fields whose value is missing or `derived`.
2. For each such field, compute the **swing**: re-run `reuse.score_reuse` with the field set to the low end and the high end of its plausible range from `fields.yaml`, and take the largest change in `overall`. The baseline score uses `reuse_missing_input_score`. This is the same value-of-information idea as `transit.suggest_measurements`.
3. Job swing = the largest swing among its fields. Sort by swing, then by distance to the nearest station (`common.euclid_to_stations`).
4. Take the top `research_max_buildings` (new factor, `verified: false`, start at 30). Skip jobs with swing below `research_min_swing` (new factor, start at 0.05).

It must be deterministic for a given fixture set, so the same locale always produces the same queue. Pin this with a test.

## 6. Making it work for any locale

Nothing in `backend/research/` names a locale. The pipeline reads:

- `Locale`: `bbox`, `boundary`, `county_fips`, `jurisdiction`, `stations`, `sources_from`.
- the state, taken from the first two digits of `county_fips` (state FIPS code).
- the three registries below.

A new locale or drawn area needs **no code change**. At most it needs a `sources.yaml` entry for its county and state, and if that entry is missing, the run still works with only the global sources.

### 6.1 Field registry: `backend/research/fields.yaml`

One entry per researchable schema field. It is the single place the verifier gets units and ranges.

```yaml
vacancy_pct:
  target: building           # building | parcel
  unit: "%"
  parse: percent             # parser in verify.py: percent | usd | usd_per_sqft_yr | integer | sqft | year | enum
  range: [0, 100]
  plausible: [5, 95]         # for the gap-queue swing, not for verification
  max_age_years: 3           # older as_of -> reject
  cross_checks: []
  confidence_by_source_type: {brokerage_report: medium, building_profile_study: medium, press: low, listing: low}
stories:
  target: building
  parse: integer
  range: [1, 120]
  cross_checks: [osm_levels_within_2]
  ...
last_sale_usd:
  target: parcel
  parse: usd
  range: [10000, 5.0e9]
  blocked_in_states: []       # filled from sources.yaml policies (e.g. non-disclosure states)
```

Start with: `vacancy_pct`, `asking_rent_usd_sqft_yr`, `parking_spaces`, `building_class` (enum A/B/C), `year_built`, `year_renovated`, `stories`, `rentable_area_sqft`, `typical_floor_sqft`, and the parcel fields `owner`, `last_sale_usd`, `last_sale_year`. Leave `lease_expiry_year` out; there is no reliable public source, and docs/04 already handles "lease status unknown."

### 6.2 Source registry: `backend/research/sources.yaml`

It has three layers, from most general to most specific, merged in order (later layers win):

```yaml
global:
  denylist_domains: [loopnet.com, costar.com, apartments.com, homes.com, landsofamerica.com, ten-x.com]
  source_types: [assessor_card, brokerage_report, building_profile_study, press, city_filing, listing, sec_filing]
  search_query_templates:
    building: ['"{address}" office building', '"{name}" {city} stories square feet', '"{address}" sold']
    market:   ['{submarket} office market report {year} vacancy asking rent']
states:
  "48":                       # Texas
    policies:
      non_disclosure: true    # no sale prices in public records; don't search for last_sale_usd
  "06": {}                    # California
  "12": {}                    # Florida
counties:
  "12009":                    # Brevard
    preferred_domains: []     # TODO(kickoff): appraiser property-card host, if its cards are public
    notes: "county parcels carry no year built; the appraiser card may"
  "48201": {}                 # Harris
  "06037": {}                 # Los Angeles
```

Policies change what the pipeline does in code, not only what the prompt says. For example, `non_disclosure: true` removes `last_sale_usd` from the queue for that state. Nothing should depend on the LLM obeying an instruction.

### 6.3 Skills: `backend/research/skills/`

These are deepagents skills (`SKILL.md` with YAML `name` and `description` frontmatter), passed as `skills=[...]` to the subagents. There is **one skill per source type, not per locale**, so all locales use them:

- `assessor-card`: reading a county appraiser or assessor property card. Year built, building area and use code live here. Usually an HTML table.
- `brokerage-report`: quarterly office and retail market PDFs (CBRE, Colliers, JLL, Cushman, NAI, Partners, Matthews …). Submarket tables, vacancy vs availability, NNN vs full-service rent.
- `building-profile-study`: conversion studies and BID or downtown-alliance studies, like the AECOM Houston study used in `research/buildings_source.yaml`.
- `press`: trade press (Bisnow, The Real Deal, Connect CRE, business journals). Sale prices, owners, occupancy. Always record `as_of`.
- `city-filing`: permits, TDLR-style registrations, planning case files. Units and stories for proposed work.
- `quoting-rules`: shared by all subagents. Quote verbatim. Never round or convert inside the quote. One fact per quote. Say `not_found` instead of guessing.

Skills hold the *how*. `sources.yaml` holds the *where* and *what is allowed*. A new locale should usually need neither a new skill nor a new prompt.

## 7. Verifier (`backend/research/verify.py`)

This step is what keeps ground rules 1 and 4 intact. It is pure apart from reading the HTTP cache. A fact is **accepted** only if all of these pass:

1. **Allowed source:** the domain is not on the denylist, and the URL is in the HTTP cache (`http_cache.retrieved_at(url)` is not None). The agent must have fetched the page through `fetch_page`.
2. **Quote present:** the normalized quote (whitespace collapsed, quotes and dashes unified) is a substring of the cached page's extracted text. For PDFs, use the text of `page` if given, else the whole document.
3. **Value comes from the quote:** the `parse` function for the field extracts exactly one value from the quote, and it equals `fact.value` within rounding. The **parsed value** is stored, never the LLM's.
4. **Range:** the value lies inside `fields.yaml` `range`.
5. **Fresh:** `as_of` is within `max_age_years`, when it is given. A missing `as_of` caps confidence at `low`.
6. **Cross-checks** (each is a pure function that takes the merged building):
   - `osm_levels_within_2`: stories vs OSM `building:levels`.
   - `area_vs_footprint`: rentable area / (footprint × stories) inside the range in factor `research_area_ratio_range` (new, `verified: false`).
   - `typical_floor_le_footprint`: typical floor area at most footprint × factor `research_footprint_slack` (new).
7. **Identity:** the cached page mentions the building's address number and street name, or its name, within N characters of the quote. This catches the right number attached to the wrong building.

Each rejection goes to `<locale_dir>/agent_research/rejects.jsonl` with the failed check, so a person can inspect it. Accepted facts get provenance `source="agent_research"`. Confidence comes from `confidence_by_source_type`, capped at `medium`. `note` = `"<quote>" (<source_type>, as of <as_of>; agent-found, code-verified)`. The `retrieved_at` comes from the HTTP cache metadata.

When `agent_research` and `public_research` or `costar` disagree, the resolver's provider order decides, which is already the rule. The verifier also logs the conflict.

## 8. Recording integration

### 8.1 Recorded locales

`doppler run -- uv run python scripts/record_fixtures.py --locale <id> --only agent_research`

1. Requires the `osm`, `county` and `research` steps to have run already. If they haven't, exit with a clear message.
2. Builds a `RunContext` like the locale tests do, then runs the zoning and infrastructure agents deterministically. `score_reuse` needs envelopes and readiness to compute swings.
3. Queue → agent → verifier → `agent_research/buildings_source.yaml` → linker → `buildings.json` and `parcels.json`.
4. Prints: jobs run, facts proposed, facts accepted, rejects broken down by check, and tokens used.
5. **A person reviews the YAML diff before it's committed.** The YAML is the reviewable artifact; the JSON is generated.

The step must be **resumable**. Key results by `job_id` in `cache/research/<locale>/results/`, so a crash or re-run doesn't pay twice. Use the HTTP cache for pages and a LangGraph checkpointer (`checkpointer=` on `create_deep_agent`) for the agent state.

### 8.2 Drawn areas (`cache/areas/<id>/`)

- Add `"agent_research"` as the last item in `METRO_STEPS`, gated by `settings.AREA_RESEARCH` (new env var, default off). Area recording then doesn't depend on an LLM key or get slower.
- When it's on, run it **after** the plan is available. Use a background thread, or a deepagents `AsyncSubAgent` if that fits the API. Each accepted fact is emitted as an SSE event, and the UI calls the existing `rescore` (under 300 ms, no LLM) when the run finishes. The plan never waits on research.
- Results stay in `cache/areas/<id>/agent_research/` and are never committed (ground rule 6).

## 9. deepagents setup (installed version: 0.7.38)

Check the installed source before writing code (`.venv/lib/python3.11/site-packages/deepagents/graph.py`, `middleware/subagents.py`, `middleware/skills.py`). These are the pieces this spec relies on, all present in 0.7.38:

- `create_deep_agent(model, tools, system_prompt, subagents, skills, backend, response_format, checkpointer, ...)`
- `SubAgent` TypedDict with `name`, `description`, `system_prompt`, `tools`, `model`, `skills`, `response_format`. One subagent per job gives isolated context.
- `FilesystemBackend(root_dir=cache/research/<locale>/pages, virtual_mode=True)`, so `fetch_page` writes the page text there and the subagent can `grep` and `read_file` long PDFs instead of holding them in context. The real source of truth is still the HTTP cache. Files are only a working copy.
- Turn off `execute` (no sandbox needed). Use a `HarnessProfile` with `excluded_tools`, or a custom `FilesystemMiddleware(tools=[...])`.

Model: use `settings.MODEL` (see `docs/model-eval.md`), with a cheaper model allowed for subagents through `SubAgent.model`. Log tokens per job, as `coordinator._tokens` does.

`TODO(kickoff)`: **search provider.** There's no search key in `.env.example` or Doppler. Options: Anthropic's server-side web search tool through `langchain-anthropic` (no extra key, but check that the bound tool dict format works with the installed version), or a search API whose key goes in Doppler. Put it behind `web_search(query) -> list[{url, title, snippet}]` in `research/tools.py`, cache it through `http_cache` (or a file cache keyed by query for a server-side tool), and ship a fixture-backed fake for tests.

## 10. Tests (`doppler run -- uv run pytest`; all offline)

- `test_research_queue.py`: deterministic order on a recorded locale. Fields that `costar` or `public_research` already supply are never queued. State policies remove fields (Texas → no `last_sale_usd`).
- `test_research_verify.py`: tables of quote and page fixtures. Accept a clean fact. Reject: the quote isn't on the page; parsed value ≠ claimed value; out of range; denylisted domain; page never fetched; stale `as_of`; the identity check fails (right number, wrong address); stories conflict with OSM by more than 2.
- `test_research_provider.py`: `AgentResearchProvider` sits below `costar` and `public_research` and above `county_parcels`, and every value carries `source="agent_research"` with the quote in `note`.
- `test_research_agent_fake.py`: run the whole pipeline with a fake chat model (scripted tool calls) and a fake search on one locale. Check that the YAML it writes matches the `research/buildings_source.yaml` shape and that the linker accepts it.
- Existing locale tests stay green **with and without** `agent_research/` fixtures present. Brevard's "no value has source `costar`" check still holds.

## 11. Acceptance criteria

- [ ] Runs on all three recorded locales with no code changes between them.
- [ ] Runs on a drawn area in any US county with `AREA_RESEARCH=1`, and the plan does not wait on it.
- [ ] Every accepted value: the quote is in the cached page, the value was parsed by code, and the provenance names its URL and quote.
- [ ] Zero accepted facts from denylisted domains. Zero `last_sale_usd` facts in Texas.
- [ ] `DEMO_OFFLINE=1 uv run uvicorn backend.app:app` works with the new fixtures and needs no key.
- [ ] Backtest unchanged: One City Centre stays in the top 10% of Houston office candidates (docs/11). Track Elev8's ±25% unit estimate too.
- [ ] Report coverage before and after, using the table in §1 (a script in `scripts/` is fine).

## 12. Build order (each step runnable and tested; ground rule 9)

1. `fields.yaml` and `verify.py` with table tests. No LLM yet.
2. `models/research.py` gap queue and its test.
3. `AgentResearchProvider` plus the resolver slot, tested with a hand-written `agent_research/buildings.json` fixture.
4. Tools with a fake search, plus `record_agent_research` running on a fake chat model end to end.
5. Real model and real search (after the §9 `TODO(kickoff)`) on **Brevard** first. It has the thinnest data and no CoStar to conflict with. Review the diff with the human.
6. Houston, then LA. Then the drawn-area path behind `AREA_RESEARCH`.
7. Market researcher → `factors.yaml` proposals (`verified: false`). Last, because a person has to check each one.

## 13. Related deterministic fix (do separately, first)

`norm_brevard` in `backend/data/record.py` hard-codes `year_built: None`, which is why Brevard has year built for 0/228 buildings. If the Brevard Property Appraiser parcel layer has a year-built field, map it there. That needs no agent and no LLM. `TODO(kickoff)`: confirm the field name from the layer's ArcGIS field list. Don't guess it.

## 14. As built (2026-11-14)

Commands: `doppler run -- uv run python scripts/record_fixtures.py --locale <id> --only agent_research` (and `--only agent_market` for the market proposals); both run only when named, never in the default step list. Coverage: `DEMO_OFFLINE=1 uv run python scripts/research_coverage.py`.

Differences from the text above, and why:

- **No LLM coordinator.** The gap queue already decides what to research, so `backend/research/agent.py` drives the jobs in Python (4 threads) and gives each its own building-researcher deep agent (isolated context, one LangGraph thread per job, SQLite checkpointer in `cache/research/<locale>/checkpoints.sqlite`). There is no `prompts/coordinator.md`.
- **`submit_facts` is `check_facts`.** It dry-runs the verifier and saves nothing; the answer is the final `ResearchedBuilding` / `ResearchedMarket` tool call (`ToolStrategy`). With the original name, Haiku kept "submitting" and never answered.
- **Hard budgets in the tools**: 6 searches, 8 fetches, 3 checks per job (`research/tools.py`); the prompt alone did not stop the model.
- **Agent research only fills gaps.** A fact for a field any other source already has (CoStar, hand research, county, OSM name or levels) is rejected as `already_known`, with the existing value in `rejects.jsonl`. That is the conflict log; agent values never override anything, even the county below it.
- `ResearchedFact` has a `source_type` (the confidence table needs it) and there is a `ResearchedMarket` answer model.
- **Parsing:** when a quote holds several values of the field's kind, the one closest to a field keyword (`fields.yaml` `keywords`) wins, so `PARKING: 1,300 spaces between 2 decks` parses. A range or alternative (`between 1857 and 1869`, `$24 - $28`) is always rejected. Identity runs before the cross-checks.
- A missing `as_of` caps confidence at `low` only for time-varying fields (those with `max_age_years`).
- **Market proposals** go to `<locale_dir>/agent_research/factor_proposals.yaml` (factors.yaml entry shape, `verified: false`) for a person to copy in, rather than being written into `factors.yaml` automatically.
- **Drawn areas:** `areas.METRO_BACKGROUND_STEPS` (set only when `AREA_RESEARCH=1`) holds the step. `backend/app.py` runs it after "Plan ready" and keeps the SSE stream open. It streams one `building_reuse` event per accepted fact, rebuilds the plan deterministically under the same id, and sends a final coordinator `done` event; the UI reloads the plan and re-applies its edits through `rescore`.
- **Search:** Anthropic server-side web search through the `anthropic` SDK (`RESEARCH_SEARCH=anthropic`, existing key, CoStar domains in `blocked_domains`), cached by query in `cache/research/search/`; `fixture:<path.yaml>` for tests. Confirmed by the team 2026-11-14.
- §13: the Brevard parcel layer (`Parcel_New_WKID2881/MapServer/5`) has no year-built field (field list checked 2026-11-14), so the Brevard registry entry maps no `year_built`. The appraiser card is the source, through agent research.

## 15. US-wide onboarding agents (2026-11-14)

Drawn areas work in any US county. Per-place configuration that used to be hand-written in `record.py`, `land_use_maps.yaml` and the providers now lives in a committed registry, `backend/registry/`:

- `us_states.yaml` (Census FIPS → USPS, name); `states/<fips2>.yaml` (state jurisdiction id, `policies` such as `non_disclosure`);
- `counties/<fips5>.yaml`: `transit_feeds`, `parcels` (layer URL, `where`, field-expression DSL in `backend/onboard/parcels.py`, value `notes`, `coverage`), `land_use` (code map), `zoning` (county layers for unincorporated land), `utilities`, `research` (preferred domains, `assessor_card`), plus `recorded_locale` and `licensed_sources` (CoStar, Matterport, Vexcel run only where listed);
- `places/<geoid7>.yaml`: city `jurisdiction` (the corpus id), `zoning` (`layers`, or `none: true` with the official note), `utilities`;
- `factors/<scope>.yaml`: local values of the per-locale factors (`national`, `state-<fips2>`, `county-<fips5>`), all `verified: false`.

Every section carries `status`: `reviewed` (a person checked it; the three recorded counties), `agent_verified` (code checks passed) or `not_found`, with `verified_at` and `model`.

Agents (`backend/onboard/`, prompts in `onboard/prompts/`, skills in `onboard/skills/` plus the research skills): the LLM proposes a structured answer; code verifies it against the live source before writing anything.

| Agent | Writes | Code checks |
|---|---|---|
| transit (no LLM) | `transit_feeds` | Mobility Database `feeds_v2.csv`: active US GTFS, bbox intersects the county, span ≤ 5°, GTFS-Flex variants dropped |
| 1 parcel source scout | `parcels` | polygon layer; every DSL field exists; id, address and a use field mapped; ≥ `onboard_parcel_min_sample` parcels in the sample box; id/address/use shares; plausible years and values |
| 2 use-code mapper | `land_use` | code list page fetched; ≥ `onboard_land_use_code_page_share` of sampled parcels (count-weighted) have a code on it; `extend` maps new codes from drawn areas (new keys only) |
| 3 zoning layer scout | `zoning` (place and county) | polygon layer, field exists and is filled on ≥ `onboard_zoning_field_share`, ≥ 2 codes; `no_zoning` needs a fetched official page quoting "zoning"; county layers get a `<County> ` prefix |
| 5 utilities scout | `utilities` | line/polygon layer, `where` runs, ≥ 1 feature in the area; failing layers dropped |
| 6 local factor researcher | `factors/state-*`, `factors/county-*` | the research verifier (quote on a fetched page, value parsed from it, range, age, scope named near it) |
| 7 assessor-card scout | `research.assessor_card`, state `non_disclosure` | the fetched card shows the sample parcel's id and address; non-disclosure needs an official quote naming disclosure and the state |
| 4 legal corpus builder | `backend/corpus/proposed/<jurisdiction>/` only | official https host (`onboard/legal_domains.yaml`), sections verbatim on the page, quotes verbatim in their section, numbers in their quote, known rule kinds/attributes/uses |

Rejected final answers go to `cache/onboard/<key>/rejects.jsonl` and the section stays absent, so the next run retries. Thresholds are `onboard_*` factors (`verified: false`, team choice).

When agents run: `areas.record_area` calls `onboard.run.onboard_county` before recording a drawn area (sections already present are skipped; LLM sections need `ANTHROPIC_API_KEY` and network), and `scripts/onboard.py` (`--county`, `--assessor`, `--corpus`, `--seed-national-factors`, `--outlines`). The building researcher runs the assessor-card scout once per county. Legal rules are never used until a person runs `scripts/review_corpus.py <jurisdiction> --approve` (ground rule 3); state law applies to every city and county in the state (`corpus/loader.py`), and legal path kinds (`new_construction | conversion | both`) live in `backend/corpus/paths.yaml`.

Factor resolution for per-locale keys: the area's own `factors.yaml` (ZORI rent and PVWatts solar from the `local_factors` step) → the recorded locale (counties with `recorded_locale`) → county → state → national. `national.yaml` holds the median of the three recorded locales, labelled as a placeholder rather than a national statistic.
