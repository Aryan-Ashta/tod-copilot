---
name: legal-text
description: How to find official zoning and housing law text (municipal codes on Municode, American Legal, eCode360, Code Publishing; state statutes on legislature sites) and copy sections verbatim with their headings.
---

# Official legal text

Only official text counts: the city/county code publisher or the state legislature site. Never news, blogs,
law-firm summaries or AI summaries.

## Where codes live
- Municipal codes: `library.municode.com/<st>/<city>/codes/...`, `codelibrary.amlegal.com/codes/<city>/...`,
  `ecode360.com/<id>`, `<city>.municipal.codes`, `codepublishing.com/<ST>/<City>/`. Some cities host their own
  `.gov` code pages or PDFs.
- State statutes: `leg.colorado.gov`, `leginfo.legislature.ca.gov`, `flsenate.gov/Laws/Statutes`,
  `statutes.capitol.texas.gov`, etc.
- Municode pages are JavaScript-heavy; if a fetch returns little text, try the code publisher's print/PDF link or
  the city's own PDF of the chapter.

## Copying sections
- A section = its heading exactly as printed (`Sec. 59-2.3. Uses permitted`, `§ 12.22 A.26`) plus its text,
  copied verbatim from the fetched page. Do not paraphrase, reorder or fix typos. 40–8000 characters each.
- Prefer the specific subsection that states the rule (a table row's district, a numbered paragraph).
- Quotes in rules must be verbatim spans of that section's text, and any number in a rule must appear in its quote.

## What to look for
- Which zones allow multifamily housing, including in commercial and mixed-use zones.
- Office-to-residential conversion / adaptive reuse provisions.
- Transit-oriented development overlays, height or density near transit.
- Density bonus programs; parking minimums near transit (or their elimination).
- Height, FAR and density limits of the main commercial and mixed-use districts.
- By-right vs discretionary (special/conditional use, hearing) approval.
If the official text does not cover a topic, list it in `not_covered`; never fill it in.
