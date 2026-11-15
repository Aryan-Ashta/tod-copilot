# Transitor

Transitor plans transit-oriented development (TOD) for a place from a single prompt. Type a place or draw an area on the map, and it produces a full station-area plan:

- the transit and infrastructure already there
- the buildings that could be converted to other uses
- the land that could be built on
- what the law allows
- how to acquire and pay for the land
- what the plan means for carbon and health

Live demo: [transitor.us](https://transitor.us). The server has 2 GB of RAM, so use the demo areas there (Houston, Los Angeles, Brevard County FL). Planning a new custom area needs more memory than it has.

## Why

Cities lose months while agencies try to agree on one plan, even a plan that is meant to change over time. Geoffrey Urbach, emerging tech lead for San Antonio, named time as one of the largest problems cities face. He also named car dependency, which is the problem TOD addresses.

Transitor uses agents to get a proposal about 90% of the way there. Agencies can start work while people settle the last 10%, and residents can follow how the plan was made.

## What it does

A coordinator runs eight [Deep Agents](https://github.com/langchain-ai/deepagents) in order:

| Agent | What it produces |
| --- | --- |
| Infrastructure | Maps existing transit, streets, utilities, EV chargers, broadband, schools, clinics, parks, grocery stores and flood zones. Scores how ready each block is to take on more people. |
| Transit network | A phased network (on-demand vans → frequent buses → BRT) within a yearly operating budget. Ridership is shown as a range, along with the measurement that would narrow it most. |
| Zoning and legislation | Which legal paths apply to each parcel and what each path allows, citing the exact legal text. |
| Site | Underused land near stops: surface parking, one-story retail, vacant lots, lots that could be combined. |
| Building reuse | Scores whether existing buildings could become housing, a hotel or mixed use, and lists what blocks each conversion. |
| Land deal | Recommends whether to buy, ground lease, partner with the transit agency or pass on each site. Drafts letters to owners but never sends them. |
| Funding | Takes goals (affordable homes, total homes, conversions, frequent-transit coverage) and picks the sites that reach them with the least public funding. |
| Sustainability and health | Transport CO₂, embodied carbon saved by reuse, rooftop solar, 10-minute walk access and flood exposure. |

After the plan is built:

- **Edit mode** is a large-type, touch-friendly view for a projector or tablet. Anyone in the room can drag homes, parks, stops or conversions onto the map, and the plan re-scores in under a second.
- **The uncertainty queue** lists the cheapest measurements that would make the plan more certain, such as a manual passenger count at one stop.

## Design rules

- **Code computes every number; the LLM never does.** Pure functions in `backend/models/` produce funding, carbon, solar, walk access, ridership, conversion scores and unit counts. The LLM orchestrates the work and writes plain-language notes. If an agent fails, the same functions run without it and the numbers don't change.
- **Every value shows its source and a confidence badge.** Missing data is flagged as missing, never filled in. Every constant lives in `backend/data/factors.yaml` with a source URL.
- **Every legal claim cites the corpus.** Clicking a legal value opens the exact text it came from. If the corpus doesn't cover a question, the answer is "not covered."
  - Rules a person has reviewed are labeled reviewed.
  - Rules the corpus agent builds while onboarding a new county are labeled **agent-verified, not reviewed**. Code first checks that each comes from an official host and that its quote appears word for word in the fetched source. They keep that label until a person approves them with `scripts/review_corpus.py --approve`.
- **The demo runs offline.** Every external call is cached, and `DEMO_OFFLINE=1` reads only fixtures and cache.

## Data

- **CoStar** building and market data, **Matterport** interiors and **Vexcel** aerial imagery score how well buildings can be reused. They are licensed for hackathon use only, so their recorded data is git-ignored.
- **Public-data research path.** CoStar doesn't cover every building: in the Houston test area, only 17 of 142 candidate buildings had any CoStar values. So a second path runs without it:
  - Deep Agents research subagents search assessor records, city filings, brokerage reports and press articles.
  - A queue ranks each missing fact by how much it could change the plan, and the agents work on the most important gaps first.
  - Code accepts a value only if its quote appears in the saved source page.
- **Other public sources:** OpenStreetMap, GTFS, the Census, FCC broadband maps, HUD, FEMA flood zones, AFDC chargers, PVWatts and Zillow's rent index.

Three test locales, each with a purpose (`docs/11-test-locales.md`):

| Locale | Tests |
| --- | --- |
| Houston, downtown | Building reuse |
| Los Angeles, Wilshire / Koreatown | Overlapping laws |
| Brevard County, Cocoa | Running with no CoStar data |

Drawing an area in any other US county first runs the onboarding agents (`backend/onboard/`). They find the county's parcels, land use, zoning, utilities and legal documents, and research its local cost factors.

## Model choice

We benchmarked Claude Haiku 5.5, Sonnet 5.5, Opus 5.5 and Sonnet 4.6 as the coordinator. Haiku 5.5 was the only one to finish every run in time without a fallback, and 93% of the numbers in its notes matched the tool outputs. All three test runs together cost about $0.07, so Haiku 5.5 is the default. Method and results: `docs/model-eval.md`.

LangSmith traces every agent run, with inputs and outputs hidden so licensed CoStar values never leave the server.

## Stack

- **Backend:** Python 3.11+, FastAPI, Pydantic v2, LangChain Deep Agents, `uv`. Agent progress streams to the browser over server-sent events.
- **Geo and math:** GeoPandas, Shapely, OSMnx/NetworkX (walk routing), NumPy, SciPy (transit optimization, finance, carbon).
- **Frontend:** React, TypeScript, Vite, MapLibre GL + deck.gl (3D map), Tailwind.

## Running it

Requires Python 3.11–3.12, [`uv`](https://docs.astral.sh/uv/) and Node.

```sh
# Offline demo: no secrets, no network
uv sync
DEMO_OFFLINE=1 uv run uvicorn backend.app:app      # API on :8000
cd frontend && npm install && npm run dev          # UI on :5173
```

Live data and agents need API keys. The team keeps them in Doppler, others can put the variables listed in `.env.example` into a local `.env`.

```sh
doppler run -- uv run uvicorn backend.app:app --reload
doppler run -- uv run pytest                                   # unit + locale tests
doppler run -- uv run python scripts/precompute_demo.py        # cached demo runs
doppler run -- uv run python scripts/onboard.py --county <fips5>
```

## Repo layout

```
backend/
  app.py          FastAPI routes and SSE stream
  schemas.py      Shared Pydantic models
  agents/         The eight planning agents and the coordinator
  models/         Pure functions: transit, zoning, reuse, infrastructure, finance, targets, rescore
  data/           Provider resolver (CoStar and public) and factors.yaml
  research/       Public-data research subagents
  onboard/        County onboarding agents, including the legal corpus builder
  corpus/         Legal corpus: reviewed docs and rules, plus agent/ for agent-verified ones
  registry/       Per-county and per-place data source config
  fixtures/       Recorded responses for the three test locales
frontend/src/     React app
scripts/          Fixture recording, onboarding, corpus review, demo precompute, model eval
docs/             Spec, architecture, data layer, agents, math, frontend, demo plan
```

`AGENTS.md` holds the rules coding agents follow in this repo. `docs/01-product-spec.md` and `docs/02-architecture.md` are the place to start reading.

## What's next

- Grow the public-data research pipeline so plans are more accurate where CoStar has no data.
- Bring more counties on board with reviewed legal sources.
- Run on a server large enough to plan any area live.

## Team

Built at HackPrinceton 2026 by Aryan Ashta, Samuel Shuster and MatthewC141.

## License

[MIT](LICENSE)
