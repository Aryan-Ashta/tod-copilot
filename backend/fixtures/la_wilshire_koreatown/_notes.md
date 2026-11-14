# Data notes

- TODO(kickoff): no public water main layer recorded; treated as missing.
- sewer_main: LA Sanitation sewer pipes (utilities/sewer_main.geojson; source in utilities/_meta.json).
- power_substation: not recorded. The national HIFLD Electric Substations dataset is listed on data.gov with accessLevel "restricted public" (https://catalog.data.gov/dataset/electric-substations-c633a); only unofficial partial mirrors are public, and no city/utility substation layer was found. Power is missing and is not part of the served check.
- broadband: FCC Broadband Data Collection, availability as of December 31, 2025, summarized per H3-8 cell by Esri Living Atlas ("FCC Broadband Data Collection December 2025 (Latest)"); served = BSLs with >= 100/20 Mbps low-latency wired or licensed fixed wireless; a cell counts as served at 100/20 when served_share exceeds factor broadband_served_share_min (applied in backend/data/providers/fcc.py) (fcc/broadband.json).
