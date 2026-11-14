---
name: brokerage-report
description: How to read quarterly office and retail market reports and building flyers from brokerages (CBRE, Colliers, JLL, Cushman & Wakefield, NAI, Partners, Matthews, Avison Young). Covers submarket tables, vacancy vs availability, and NNN vs full-service rent.
---

# Brokerage market reports and flyers

`source_type: brokerage_report`. Usually PDFs: grep the saved text, then quote from the right `=== page N ===`.

## Building facts
- Leasing flyers and offering memoranda give stories, RBA, typical floor, parking ratio or spaces, class, and
  year built / renovated. Quote each label with its value.
- A parking **ratio** (`3.1/1,000 SF`) is not a space count. Only quote a count (`1,604 spaces`).

## Market tables (market researcher)
- Submarket tables list inventory, vacancy %, availability %, net absorption and asking rent per submarket.
  The quote must hold the submarket name and one value; when a table row flattens to many numbers, quote the
  smallest span that keeps the name and the single value, or say not_found.
- **Vacancy ≠ availability.** Availability includes space still occupied but on the market. Only quote vacancy.
- **Rent basis.** Note whether rent is full service (FS/gross) or NNN in the quote when the report says so.
  Texas and most office reports are full service; industrial and retail are usually NNN.
- `as_of` is the report quarter (`Q3 2026`). Reports older than two years are rejected.
