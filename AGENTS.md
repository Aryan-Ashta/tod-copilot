# AGENTS.md: TOD Copilot (software-only)

You are helping a 3-person team build **TOD Copilot** at HackPrinceton (Fri Nov 13, 8 pm → Sun Nov 15, 8 am submission). It plans transit and transit-oriented development (TOD) for a place from one prompt: where transit and infrastructure already are, which buildings can be converted to other uses, which land can be built on, what the law allows, how to get the land and pay for it, and how the plan scores on carbon and health.

This is a **software-only** build. There is no hardware. Read `docs/01-product-spec.md`, `docs/02-architecture.md` and `docs/11-test-locales.md` before your first task.

## Ground rules (non-negotiable)

1. **Numbers come from code, never from an LLM.** Funding, carbon, solar, walk access, ridership, conversion scores and unit counts are computed by functions in `backend/models/`. LLMs may explain numbers, never produce them.
2. **Every factor has a source.** Any constant (emission factor, cost per unit, floor-plate depth threshold) lives in `backend/data/factors.yaml` with `value`, `unit`, `source_url` and `verified: true|false`. Never hard-code a factor elsewhere. If you need one that is not there, add it with `verified: false` and tell the human. Agent-researched local values of per-locale factors live in `backend/registry/factors/<scope>.yaml` (`national`, `state-<fips2>`, `county-<fips5>`) with `verified: false`, and `resolve()` uses them in the order area → recorded locale → county → state → national.
3. **Legal claims come only from the curated corpus** in `backend/corpus/`, and every rule carries a citation (`docs/10-legal-corpus.md`). If the corpus does not cover a question, the answer is "not covered," not a guess.
4. **Every data value carries provenance:** source, confidence, retrieved time (`docs/03-data-layer.md`). Missing data is flagged as missing, never filled in.
5. **Never invent API endpoints, fields or credentials.** Anything marked `TODO(kickoff)` is unknown until the team fills it in, especially CoStar field names. Stop and ask, or write an interface plus a fixture-backed fake.
6. **Every locale has a purpose.** Only the three locales in `docs/11-test-locales.md` are recorded and committed. Users may draw a sub-area inside one of them, or an area in any US county. A county is onboarded by the agents in `backend/onboard/` (data sources, land-use codes, zoning, utilities, local factors; legal rules are staged for a person to approve). Drawn-area data is recorded live into `cache/areas/` (git-ignored) and never committed; registry config in `backend/registry/` is committed after review. CoStar, Matterport and Vexcel run only for counties whose registry entry lists them in `licensed_sources`.
7. **Cache every external call** to `cache/` keyed by request. The demo must run with Wi-Fi off (`docs/08-demo-and-fallbacks.md`).
8. **Secrets** live in Doppler: project `tod-copilot`, config `prd` (pinned in `doppler.yaml`). Run backend commands under `doppler run --`, which injects them as environment variables. Never commit a secret; `.env.example` lists the variable names only. A local `.env` (git-ignored) still works as a fallback, but Doppler's values win when both are set.
9. **Small, working increments.** Each task ends runnable, with a test or a script that shows it works. Don't refactor beyond the task.
10. **The demo is the product.** When in doubt, choose what makes the 2-minute demo reliable over what makes the code general.

## Stack

- **Backend:** Python 3.11+, FastAPI, Pydantic v2, `uv` for packages. LangChain `deepagents` for agent orchestration. Check the installed version's docs before using its API; it has changed between releases.
- **Geo and math:** GeoPandas, Shapely, OSMnx/NetworkX (walk routing), NumPy, SciPy or OR-Tools (route selection), pandas.
- **Frontend:** Vite + React + TypeScript, MapLibre GL JS with deck.gl overlays (3D buildings), Tailwind. Server-sent events for live agent progress.

## Repo layout

```
backend/
  app.py              FastAPI app, routes, SSE stream
  schemas.py          Shared Pydantic models (single source of truth)
  data/               Capability resolver + providers (costar, public)
    factors.yaml      Every numeric factor with its source
  agents/             The eight agents + coordinator
    prompts/          One prompt file per agent
  models/             Pure functions: transit, zoning, reuse, infrastructure, finance, targets, rescore
  corpus/             Curated legal text + structured rules
  fixtures/<locale>/  Recorded API responses + locale.yaml, per test locale
  tests/              Unit tests + tests/locales/ golden tests
frontend/
  src/                React app (see docs/06-frontend.md)
cache/                Git-ignored response cache
scripts/              precompute_demo.py, record_fixtures.py
```

## Commands (keep these working)

- `doppler run -- uv run uvicorn backend.app:app --reload` starts the API on :8000
- `cd frontend && npm run dev` starts the UI on :5173 (needs no secrets)
- `doppler run -- uv run pytest` runs unit and locale tests
- `doppler run -- uv run python scripts/precompute_demo.py` builds the cached demo runs for all three locales
- `doppler run -- uv run python scripts/record_fixtures.py --locale <id>` records fixtures (Matterport/Vexcel keys come from Doppler)
- `doppler run -- uv run python scripts/record_fixtures.py --locale <id> --only agent_research` runs agent research (LLM + web search, `docs/12-agent-research.md`) into `agent_research/`; a person reviews `agent_research/buildings_source.yaml` before committing
- `DEMO_OFFLINE=1` makes every provider read fixtures/cache only; the offline demo needs no secrets, so `DEMO_OFFLINE=1 uv run uvicorn backend.app:app` works without Doppler or Wi-Fi
- First time on a machine: `doppler login`, then `doppler setup` in the repo root (reads `doppler.yaml`)
- Doppler injects secrets at process start: after changing a secret in Doppler, restart the API

## Conventions

- Types first: add or change models in `backend/schemas.py`, then mirror them in `frontend/src/types.ts`.
- Pure functions in `backend/models/` take plain data and return plain data: no I/O, no LLM calls. Re-scoring one plan must take under 300 ms.
- Agent outputs are Pydantic objects, never free text the UI has to parse.
- Units in names: `area_acres`, `cost_usd`, `floor_depth_ft`, `co2_tonnes_per_year`.
- Log each agent step as an SSE event (`docs/02-architecture.md`).

## When you are unsure

Write the question as a `TODO(kickoff): ...` comment, build the rest behind an interface with a fixture, and say what you assumed in your final message.
