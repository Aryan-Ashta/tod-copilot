# 10: Legal corpus

The zoning & legislation agent may only state rules found here. The corpus is small, curated by a human, and every passage is traceable to an official source.

## What goes in (one set per locale)

| Locale | Legal paths | Documents (`TODO(kickoff)`: download official text) |
| --- | --- | --- |
| Houston | "Houston development rules" (no zoning districts) | City development ordinance sections on lot size, setbacks, parking; any downtown conversion incentive documents (Downtown Redevelopment Authority / Downtown Houston+) |
| Los Angeles | "SB 79 new construction"; "LA Citywide Adaptive Reuse" | SB 79 (2025) as chaptered and state guidance; LA Citywide Adaptive Reuse Ordinance (effective Feb 1, 2026) and LA City Planning's materials; California density bonus law |
| Brevard / Cocoa | "County/city land development code" | Brevard County and City of Cocoa code sections for the station area; anything adopted for the Brightline station area |

Official sources only (legislature, the city's planning site, municode). Trade press can explain a law but can't be cited as the law.

## Layout

```
backend/corpus/
  index.yaml
  houston/<doc_id>.md
  california/<doc_id>.md
  los_angeles/<doc_id>.md
  brevard/<doc_id>.md
  rules/houston.yaml
  rules/los_angeles.yaml
  rules/brevard.yaml
```

`index.yaml` entry:

```yaml
- doc_id: la_adaptive_reuse_2026
  title: Los Angeles Citywide Adaptive Reuse Ordinance
  jurisdiction: los_angeles
  path_name: LA Citywide Adaptive Reuse
  url: <official URL>
  retrieved_at: 2026-11-14
```

Keep each document's own section numbers as headings so citations point to real sections.

## Retrieval

BM25 (rank_bm25) over section chunks is enough at this size and keeps results deterministic. `search_corpus(jurisdiction, query, k=5)` returns `{doc_id, section, text}`.

## Structured rules

Humans write the rules the math needs, one file per jurisdiction, each rule tied to a section:

```yaml
- path: LA Citywide Adaptive Reuse
  rule: eligible
  applies_if: {property_type: {in: [office, retail, hotel, industrial, parking_garage]}, min_units: 5}
  value: TODO            # from the cited section; do not guess
  cite: {doc_id: la_adaptive_reuse_2026, section: "<section>"}

- path: SB 79 new construction
  rule: max_height_ft
  applies_if: {distance_to_stop_mi: {lte: 0.25}, stop_tier: 1}
  value: TODO
  cite: {doc_id: ca_sb79_2025, section: "<section>"}
```

`apply_rules` reads these. Any `TODO` value makes that rule "not covered" (`eligible=None`), never a default.

## Citations

- `Citation.quote` is copied verbatim from the section text (one short sentence).
- The UI links to `/api/corpus/{doc_id}#{section}`.
- A test asserts every citation's `quote` appears exactly in its section text.
