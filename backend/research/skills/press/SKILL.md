---
name: press
description: How to read trade press and news (Bisnow, The Real Deal, Connect CRE, business journals, Traded, local papers) for sale prices, buyers and owners, occupancy and building size. Always record as_of.
---

# Trade press and news

`source_type: press`. Articles give sale prices, buyers, occupancy and size, but the numbers age fast and are
sometimes rounded by the writer.

- Sale price: quote the sentence with the price and the address or name (`sold 1021 Main St. for $24.62 million`).
  `last_sale_year` comes from a sale date in a quote; the article date is not the sale date.
- Owner / buyer: quote the sentence naming the buyer; set `as_of` to the sale or article date.
- Occupancy is not vacancy. `9 percent occupied` is not `vacancy_pct: 91`; never compute. Say not_found unless
  the article states vacancy.
- `as_of` is required: use the date the article gives for the fact, else the article's publication date.
- Paywalled pages often fetch only a teaser; quote only what the saved text shows.
