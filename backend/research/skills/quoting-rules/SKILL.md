---
name: quoting-rules
description: Rules every researcher follows when turning a page into facts - verbatim quotes, one value per quote, no rounding or conversion, not_found instead of guesses. Read before submitting any fact.
---

# Quoting rules

Code checks every fact you submit. A fact is accepted only if all of these hold, so follow them exactly.

1. **Fetch first.** Only pages fetched with `fetch_page` count. A search snippet is never a source.
2. **Quote verbatim.** Copy 20 to 400 characters straight from the saved page text (`grep` / `read_file` the
   `/pages/...txt` file). Do not fix typos, expand abbreviations, or join text from two places.
3. **One value per quote.** The quote must contain the value you claim and, ideally, no other number of the same
   kind. Keep the label next to the number: `STORIES: 29`, `the 29-story tower`, `PARKING: 1,300 spaces`.
   For `VACANT / AVAILABLE: 72% / 93%`, quote `VACANT / AVAILABLE: 72%` (vacancy, not availability).
4. **Never round or convert.** `value` must be the number in the quote. Monthly rent, rent per unit, gross area
   when the field is rentable area, metres, or "about half" are not the field: say `not_found`.
5. **Units.** `asking_rent_usd_sqft_yr` is dollars per square foot per year (`$24 PSF`, `$31.50/SF/yr`).
   `vacancy_pct` is a percent of the building (not of the market). `rentable_area_sqft` is RBA / rentable area.
6. **Name the building.** The page must name this building's street number and street, or its name, close to the
   quote. A number from a list of other buildings does not count.
7. **Date it.** Set `as_of` to the date or quarter the source gives for the value (`Q3 2026`, `2023`,
   `March 2025`). Vacancy, rent and owner change: undated values get low confidence.
8. **PDF pages.** Set `page` to the `=== page N ===` number the quote sits under.
9. **Source type.** Set `source_type` to one of: assessor_card, brokerage_report, building_profile_study, press,
   city_filing, listing, sec_filing.
10. **No guesses.** If you cannot quote it, list the field in `not_found`. An empty `facts` list is a good answer.

Before your final answer you may dry-run facts with `check_facts`; fix or drop every rejected one. Then give the
final structured answer: only it is saved.
