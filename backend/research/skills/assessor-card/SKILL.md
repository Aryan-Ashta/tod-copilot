---
name: assessor-card
description: How to read a county appraiser or assessor property card (year built, building area, stories, use code, owner, sale history). Use when a result is a county appraisal district, assessor or property appraiser page.
---

# Assessor and appraiser property cards

Property cards are the best public source for **year built**, **building area**, **stories** and **owner**.
They are usually HTML tables, sometimes a PDF printout. `source_type: assessor_card`.

## Finding the card
- Search the address with the county name and "appraisal district", "assessor" or "property appraiser".
- Card URLs usually contain an account or parcel number. Fetch the card itself, not a search page.

## Reading it
- Tables flatten to `Label Value` text. Quote the label with its value: `Year Built 1983`, `Stories 12`.
- "Effective year built" is not year built; quote only "Year Built" / "Actual Year Built".
- Building area on a card is often **gross** or **living** area, not rentable area. Use it only if the label says
  rentable / net rentable; otherwise leave `rentable_area_sqft` as not_found.
- A card can list several improvements (buildings). Use the one matching this building; if you cannot tell which,
  say not_found.
- Owner: quote the owner line exactly (`Owner Name: EXAMPLE TOWER LP`). Set `as_of` to the roll year shown.
- Sale price: some states (Texas) do not disclose sale prices; the field is removed there. Never infer a price
  from an appraised or market value.
