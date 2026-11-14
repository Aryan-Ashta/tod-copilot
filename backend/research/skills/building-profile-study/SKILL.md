---
name: building-profile-study
description: How to read office-to-residential conversion studies and downtown alliance or BID building profiles (e.g. AECOM's Downtown Houston Office Conversion Study). Each profile page lists year built, stories, rentable area, typical floor, vacancy, rent, parking and owner for one building.
---

# Conversion studies and building profiles

`source_type: building_profile_study`. These PDFs are the richest single source: one page per building with
labelled facts, and scoring tables covering many buildings.

- Find the profile page: `grep` the building's street number and street name or its name in the saved file, then
  read the surrounding `=== page N ===` block.
- Profile labels look like `YEAR BUILT / RENOVATED: 1960 / 2010`, `STORIES: 29`, `RENTABLE BUILDING AREA:
  609,000 SF`, `TYPICAL FLOOR SIZE: 21,000 SF`, `VACANT / AVAILABLE: 72% / 93%`, `CURRENT RENTS: $18.06 PSF`,
  `PARKING: 1,300 spaces`, `OWNER: ...`.
- Split combined labels into separate facts with separate quotes: `YEAR BUILT / RENOVATED: 1960` for year_built.
  A combined `1960 / 2010` cannot be parsed for year_renovated (two years, one label): use a page that states the
  renovation year on its own, or say not_found.
- Scoring tables list many buildings per row; the verifier needs the address or name near the quote, so prefer the
  profile page.
- `as_of`: the study's data date (often stated in the introduction: "data as of Spring 2023").
- Figures in these studies are often CoStar-derived; that is fine to quote (the study is the public source).
