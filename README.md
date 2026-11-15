# Transitor: build docs for coding agents (software-only)

These files tell a coding agent (Claude Code, Cursor, Codex and others) what to build, how the pieces fit, and what it must never do. Drop them into the root of the repo.

## What changed from the first version

- **Software only.** The hardware table and sensor node are replaced by an on-screen edit mode and an "uncertainty queue" (`docs/07-interactive-planning.md`).
- **More CoStar data.** A new **Building reuse** agent scores whether existing buildings can become housing, hotel or mixed use, using CoStar building attributes, Matterport interiors and Vexcel imagery. A new **Infrastructure** agent maps where transit, streets, utilities, chargers, broadband and amenities already are.
- **Three test locales, each with one purpose** (`docs/11-test-locales.md`): Houston for building reuse, LA for overlapping laws, Brevard for the no-CoStar fallback. Each has validation tests against real published facts.

## How to use

1. Copy everything into the repo root, keeping `docs/`.
2. `AGENTS.md` is the entry point; `CLAUDE.md` points Claude Code at it.
3. Give an agent one task at a time from `docs/09-build-plan.md` ("Do task N1").
4. Fill every `TODO(kickoff)` as soon as you know it, especially CoStar field names. Agents are told to stop and ask rather than guess.

## Files

| File | What it covers |
| --- | --- |
| `AGENTS.md` | Rules every agent follows: stack, commands, conventions, non-negotiables |
| `CLAUDE.md` | Pointer to `AGENTS.md` |
| `docs/01-product-spec.md` | What the app does, the eight agents, acceptance criteria |
| `docs/02-architecture.md` | Components, shared schemas, API |
| `docs/03-data-layer.md` | Capability resolver; CoStar vs public providers by locale |
| `docs/04-agents.md` | The eight agents: tools, outputs, rules |
| `docs/05-models-and-math.md` | Reuse scoring, infrastructure readiness, transit, finance, targets, factor registry |
| `docs/06-frontend.md` | Screens, map layers, cards, provenance UI |
| `docs/07-interactive-planning.md` | Edit mode and the uncertainty queue |
| `docs/08-demo-and-fallbacks.md` | Demo script, replay/offline modes, pre-judging checklist |
| `docs/09-build-plan.md` | Tasks by owner, timeline, checkpoints, cut order |
| `docs/10-legal-corpus.md` | Corpus per locale, structured rules, citation format |
| `docs/11-test-locales.md` | The three locales, why each exists, and its validation tests |
