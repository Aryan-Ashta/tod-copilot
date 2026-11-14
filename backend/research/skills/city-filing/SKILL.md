---
name: city-filing
description: How to read public filings - building permits, state architectural registrations (e.g. Texas TDLR), planning case files and staff reports - for stories, floor area and proposed units of existing buildings.
---

# City and state filings

`source_type: city_filing`. Permits, planning case files and state registrations (TDLR in Texas) describe the
existing building and proposed work.

- Separate **existing** from **proposed**: a staff report saying "convert the existing 12-story office building
  into 180 units" gives `stories: 12` for the existing building; proposed units are not a schema field.
- Floor area in filings is usually gross floor area; only quote it as `rentable_area_sqft` if it says rentable.
- Case numbers and permit numbers are not values; keep them out of quotes when possible.
- `as_of`: the filing or hearing date.
