# 09: Build plan

Tasks are sized for one agent session each. Do them in order within a lane; each ends runnable. Reference them in prompts like "Do task R2."

Owners: **A** = Aryan (data layer, models, finance), **M** = Matthew (agents, corpus, infrastructure), **S** = Sam (frontend, meeting mode).

## Timeline and checkpoints

| When | Milestone |
| --- | --- |
| Fri 9 pm | Scaffold runs; CoStar access details and field names known; the three locale bounding boxes fixed |
| Sat 2 am | Fixtures recorded for all three locales; agent skeleton streams fake events to the UI |
| Sat 10 am | Infrastructure layer and building reuse scores visible on the Houston map |
| **Sat 2 pm** | **Checkpoint:** Houston end to end (all 8 agents, even if some are thin). If not, cut per the list below |
| Sat 6 pm | LA legal paths side by side; meeting mode re-scores under 1 s |
| Sat 10 pm | Brevard fallback run passes its golden tests |
| **Sun 2 am** | **Feature freeze:** fixes, caching, precompute, factor verification, rehearsal only |
| Sun 8 am | Devpost submitted with public repo and video |

## Cut order (if behind)

1. LA locale (demo Houston + Brevard only) → 2. Utilities and broadband layers → 3. Uncertainty queue → 4. Transit optimizer (keep existing routes; frequency upgrades only) → 5. Targets except CO₂ and embodied carbon.

**Never cut:** Houston building reuse + infrastructure, zoning citations, funding verdicts, provenance badges, Brevard fallback, offline replay.

## Tasks

### Setup

- [ ] **S0 (any):** Scaffold per `AGENTS.md`: FastAPI `/health`, Vite React map, `.env.example`, `uv` project, one passing test.
- [ ] **S1 (any):** `fixtures/<locale>/locale.yaml` for the three locales with bbox, stations, jurisdiction, data tier and purpose sentence from `docs/11-test-locales.md`; `GET /api/locales`.

### Data (A)

- [ ] **D1:** `schemas.py` as in `docs/02-architecture.md`; mirror to `frontend/src/types.ts`.
- [ ] **D2:** Resolver + cache + `DEMO_OFFLINE` with tests.
- [ ] **D3:** `CoStarProvider` for PARCELS, OWNERSHIP_SALES, LEASES, BUILDING_ATTRS; `backend/data/costar_fields.md` mapping table. Fixture-backed until `TODO(kickoff)` is filled.
- [ ] **D4:** `VexcelProvider` (imagery flags, roof area) and `MatterportProvider` (floor depth, ceiling height, windows) where scans exist; derived-interior fallback with low confidence.
- [ ] **D5:** Public providers: county parcels (Brevard), public imagery + open footprints, LODES, GTFS ×3 agencies, OSM, FEMA, AFDC, FCC broadband, city open-data utilities where they exist.
- [ ] **D6:** `scripts/record_fixtures.py --locale` for all three; commit fixtures.
- [ ] **D7:** `factors.yaml` with all keys from `docs/05-models-and-math.md`; loader exposing `verified`.

### Models (A)

- [ ] **N1:** `models/reuse.py`: five fit scores per use, overall, best use, blockers with inputs and thresholds, unit estimate. Unit tests with hand-built buildings.
- [ ] **N2:** `models/finance.py`: new build and conversion pro formas, incentives, `compare_options`.
- [ ] **N3:** `models/zoning.py`: `apply_rules` for multiple legal paths; `homes_for`.
- [ ] **N4:** `models/transit.py`: demand grid, candidates incl. frequency upgrades, budgeted selection, ridership ranges, measurement suggestions.
- [ ] **N5:** `models/targets.py`: transport CO₂, embodied carbon saved, solar, walk access, flood exposure.
- [ ] **N6:** `models/rescore.py` for all tile types; benchmark test < 300 ms.

### Agents and corpus (M)

- [ ] **G1:** Coordinator with deepagents and fake sub-agents returning fixture outputs, streaming SSE.
- [ ] **G2:** `models/infrastructure.py` readiness + Infrastructure agent.
- [ ] **G3:** Legal corpus: Houston development rules, SB 79, LA Citywide Adaptive Reuse Ordinance, Brevard/Cocoa code; `corpus/rules/*.yaml`; `search_corpus` (`docs/10-legal-corpus.md`).
- [ ] **G4:** Zoning & legislation agent with multiple paths and a recommended path.
- [ ] **G5:** Site agent and Building reuse agent.
- [ ] **G6:** Land deal agent with the decision rules; letter drafts.
- [ ] **G7:** Funding, Transit and Sustainability agents wired to models.
- [ ] **G8:** Replay mode: record and replay SSE logs.

### Frontend (S)

- [ ] **F1:** Prompt screen with three locale cards (tier + purpose); plan layout; agent checklist from SSE.
- [ ] **F2:** Map layers per `docs/06-frontend.md` with toggle panel; infrastructure group first.
- [ ] **F3:** Building reuse card: ranked table, fit-score chart, blockers, source badges; existing buildings colored by best use.
- [ ] **F4:** Zoning card with side-by-side legal paths and citation drawer; Funding card with new-build vs convert comparison.
- [ ] **F5:** Targets panel + slider; deltas animation.
- [ ] **F6:** Meeting mode with tile tray, validity checks, scoreboard, undo/reset/history (`docs/07-interactive-planning.md`).
- [ ] **F7:** Uncertainty queue panel with labeled simulated count.

### Locale tests and demo (all)

- [ ] **L1:** `tests/locales/test_houston_downtown.py`: backtests (One City Centre rank, 1801 Smith unit estimate), no "zoning district" text.
- [ ] **L2:** `tests/locales/test_la_wilshire_koreatown.py`: both legal paths per eligible parcel; Koreatown conversion backtest; at least one divergent recommendation.
- [ ] **L3:** `tests/locales/test_brevard_cocoa.py`: no CoStar values, missing-lease notes, 0% flood exposure, a frequency upgrade.
- [ ] **X1:** `precompute_demo.py` runs all locales and golden tests; offline checklist passes.
- [ ] **X2:** Verify every factor visible in the demo.
- [ ] **X3:** Judge-facing README, Devpost write-up, 2-minute video.
