# 08: Demo and fallbacks

Judging is Sunday 9:30 am–2:30 pm. Pitch is 2 minutes live plus an optional 2-minute video. Venue Wi-Fi will be bad.

## 2-minute script

1. **Hook (15 s):** about a quarter of downtown Houston's office space sits empty, and car-dependent places barely have transit. Deciding what to convert, what to build and how to connect it is the hard part.
2. **Houston, CoStar data (50 s):** pick the stock prompts → agent checklist (replay) → "Apply agent suggestions" builds the plan → infrastructure layer → conversion candidates light up by best use → click the top tower: five fit scores, blockers, sources → it becomes site A with a capital stack that pencils → embodied carbon saved.
3. **Edit mode (25 s):** hand a judge the laptop; they click "Park", then a parking lot, and "Convert to housing", then a tower; the plan history and scoreboard update.
4. **LA law (optional, 15 s):** one parcel where SB 79 new construction and the Adaptive Reuse Ordinance compete; the app shows both with citations and picks one.
5. **Brevard (15 s):** same prompt, public data only: medium/low badges, "lease status unknown," flood zones avoided, frequency upgrade on an existing bus route.
6. **Close (5 s):** "Works anywhere, sharper with CoStar."

If time is short, drop step 4.

**Demo walk-through** (`components/DemoSequence.tsx`): on the Houston and LA demo plans, → and ← step through the eight agents, and the map focus shifts with each step. In LA a rezoning step follows Zoning: it selects a parcel both legal paths apply to, flies the map there and scrolls the side panel to the recommendation; the next → deselects it, scrolls back to the top and carries on. Keys only; there is no on-screen control.

## Modes

| Mode | How | When |
| --- | --- | --- |
| Live | Normal run, LLM + cached providers | Wi-Fi fine and time allows |
| Replay | `/api/plan/{id}/stream?replay=1` | Default for judging |
| Offline | `DEMO_OFFLINE=1`; fixtures only, replay for agents | Wi-Fi down |
| Hosted | `uvicorn backend.serve:app` (the Docker image) defaults `TRANSITOR_HOSTED=1`: `POST /api/plan` returns 403 and Generate opens a modal pointing to the GitHub repo or the LA replay; set `TRANSITOR_HOSTED=0` to allow live runs | Public deployment; recorded replays only |

Re-score never needs the network, so edit mode and the slider work in every mode.

## Precompute (`scripts/precompute_demo.py`)

- Runs all three locales end to end; saves `Plan` JSON and SSE logs to `cache/plans/`.
- Precomputes walk distances, envelopes, readiness, reuse scores and PVWatts results.
- Runs the locale golden tests and prints pass/skip/fail.
- Run after every meaningful change Saturday night and once more after the freeze.

## Checklist before judging

- [ ] All three locale plans load in replay mode with Wi-Fi off.
- [ ] Locale golden tests pass or are skipped with a written reason.
- [ ] Factors visible in the demo are `verified: true`.
- [ ] Laptop on power, notifications off, browser zoom set, backup screen recording ready.
- [ ] Disclaimer in the map's info button (ⓘ, bottom right): estimates, not legal or financial advice.
- [ ] Devpost lists the tracks: Sustainability (main), CoStar, LangChain deepagents, Amazon Practical AI.
