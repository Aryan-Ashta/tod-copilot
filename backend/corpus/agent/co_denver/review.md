# Agent-built legal corpus: City of Denver, Colorado (co_denver)

Agent-built, code-checked (official host, verbatim sections, verbatim quotes, numbers in quotes). Used in plans now, labeled agent-verified. A person reviews every rule against its quote and approves with `uv run python scripts/review_corpus.py co_denver --approve`.

## Accepted rules (0)


## Documents (1)

- dzc_art7_urban_center: Denver Zoning Code Article 7: Urban Center (C-) Neighborhood Context (https://denvergov.org/files/assets/public/v/11/community-planning-and-development/documents/zoning/denver-zoning-code/denver_zoning_code_article7_urban_center.pdf), 1 sections

## Rejected by the code checks (2)

- dzc_art7_urban_center / 7.3.1 General Intent (transit): section text is not verbatim on the fetched page
- path Denver Urban Center mixed-use zoning (C-MX): no accepted rule

## Not covered

- Use table residential rows for C-MX (allows_uses not set; page text not verbatim-matched)
- Approval step counts for C-MX residential (not verified)
- Height and FAR for C-MX zones (not set)
- Downtown D-C/D-TD/D-LD/D-AS-12+/D-AS-20+ rules (not submitted)
- Office-to-residential conversion rules (only a non-code technical guidance summary was fetched; not submitted)
- Density bonus rules (10.12 text not verbatim-matched; not submitted)
- Parking minimums near transit (10.4.5.1.E text not verbatim-matched; not submitted)
- OS-A and B-8-A zone rules (no residential rules found)
- Colorado state TOD law (not fetched)
