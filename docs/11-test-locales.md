# 11: Test locales

There are exactly three test locales. Each one exists because it exercises something the other two can't. If a feature is not tested by any locale below, it is not part of the demo.

| | Houston: Downtown + Main St rail | Los Angeles: Wilshire corridor, Koreatown | Brevard County, FL: Cocoa |
| --- | --- | --- | --- |
| **Data tier** | CoStar full (parcels, owners, sales, leases, building attributes) + Vexcel + Matterport where scanned | CoStar full + Vexcel + Matterport where scanned | Public data only |
| **Unique purpose** | The **building reuse engine** on a high-vacancy office market, plus the **no-zoning** legal path | **Overlapping laws**: choose per parcel between new construction under SB 79 and conversion under LA's Citywide Adaptive Reuse Ordinance | **Fallback and greenfield transit**: plan with no CoStar data, in a car-dependent county, around a station that doesn't exist yet, with flood risk |
| **Transit context** | Existing light rail on Main St | Existing D Line subway on Wilshire | Hourly buses; future Brightline station |
| **Main agents exercised** | Building reuse, Infrastructure, Funding | Zoning & legislation, Building reuse vs Site, Funding | Transit network, Infrastructure, Sustainability (flood), resolver fallback |
| **Role in the demo** | Main run (45 s) | Optional deep-dive if a judge asks about law (20 s) | Closing contrast (15 s) |

`TODO(kickoff)`: confirm with the CoStar team that the Houston and LA areas below have CoStar coverage, and which buildings have Matterport scans. Adjust the bounding boxes to match.

---

## 1. Houston: Downtown + Main St rail corridor

**Why this locale:** Downtown Houston is the clearest real-world conversion problem. A Downtown Houston+ study found that about 73% of built real estate downtown is office space and 24% of that office inventory was vacant ([AECOM study, Nov 2023](https://centercityphila.org/uploads/attachments/cm5vpxmcw24izdtqdzc8e3hkk-bid-class-downtown-houston-office-conversion-study-optimized-11302023.pdf)). The city is shaping an incentive program, and it already ran the Downtown Living Initiative, which offered up to $15,000 per unit ([The Real Deal](https://therealdeal.com/texas/houston/2024/01/02/tax-breaks-recommended-for-office-to-resi-conversions-in-houston)). Houston also has no zoning districts, which tests whether the legislation agent handles a place where the usual rules don't exist.

**Area:** Downtown inside the freeway loop plus the Main St rail corridor south to Midtown. `TODO(kickoff)`: exact bounding box.

**What it tests:**
- Building reuse scoring on real CoStar building attributes (class, year built, floor size, vacancy, rent, parking).
- The infrastructure agent on a dense, well-served grid (most sites should score high on readiness, so gaps stand out).
- The no-zoning path: development rules and deed restrictions only; the zoning agent must say "no zoning districts" rather than invent one.
- Funding with a local incentive (Downtown Living Initiative-style per-unit rebate, as an optional factor flagged "program status: verify").

**Validation (backtests against published facts):**
- [ ] **Known top candidate:** a Downtown Houston+ study ranked One City Centre higher than any other downtown building as a conversion prospect, citing large floor plates, high vacancy, low office rent and ample parking ([Connect CRE](https://www.connectcre.com/stories/3l-provides-update-on-conversion-of-houston-highrise/)). Our engine should place it in its top 10% of downtown office candidates. If it doesn't, inspect the weights before the demo.
- [ ] **Known completed conversion:** 1801 Smith, a 1960s 20-story, 458,000 SF tower, became Elev8 with 372 apartments ([Realty News Report](https://realtynewsreport.com/new-office-conversion-study-by-downtown-houston/)). Run the engine on the building's pre-conversion attributes; it should score it as feasible, and the unit estimate should be within ±25% of 372.
- [ ] No output contains the words "zoning district" for a Houston parcel.

---

## 2. Los Angeles: Wilshire corridor, Koreatown (D Line)

**Why this locale:** Two new laws overlap here, so the legislation agent has to choose, not just look things up.
- **SB 79** raises height and density limits near major transit stops and took effect July 1, 2026 ([Holland & Knight](https://www.hklaw.com/en/insights/publications/2026/06/tracking-sb-79-implementation-before-the-train-leaves-the-station)).
- **The Citywide Adaptive Reuse Ordinance**, effective Feb 1, 2026, extends streamlined conversion of commercial buildings to housing across the whole city ([LA City Planning](https://planning.lacity.gov/odocument/0fa826b2-52c7-4ab7-ad29-e6edefed4493/Adaptive_Reuse_Ordinance_Feb_2026.pdf)). It sets up zoning incentives and streamlined procedures for converting commercial buildings into five or more homes ([Smart Cities Dive](https://www.smartcitiesdive.com/news/office-to-housing-conversion-laws-california/815582/)).

For any office building near a D Line station, both paths may apply: tear down and build under SB 79, or convert under the ordinance. Picking the better one per parcel is the test.

**Area:** Wilshire Blvd from Wilshire/Vermont to Wilshire/Western (D Line stations). `TODO(kickoff)`: confirm CoStar coverage; extend west if needed.

**What it tests:**
- Legislation agent: both regimes in the corpus, per-parcel eligibility with citations, and a side-by-side "build new vs convert" outcome.
- Building reuse vs Site agents competing for the same parcel, with the Funding agent breaking the tie.
- Mid-rise office conversions, which practitioners expect the new ordinance to favor ([Bisnow](https://bisnow.com/los-angeles/news/architecture-design/adaptive-reuse-los-angeles-ordinance-citywide-128323)).

**Validation:**
- [ ] **Known conversion:** Jamison is converting a 13-story, 233,000 SF Koreatown office building on Wilshire into 236 homes plus street-level retail ([Bisnow](https://bisnow.com/los-angeles/news/architecture-design/adaptive-reuse-los-angeles-ordinance-citywide-128323)). `TODO(kickoff)`: identify the address in CoStar. The engine should score it feasible, with units within ±25% of 236.
- [ ] Every parcel near a station shows which law path(s) apply, each with a citation, or "not covered."
- [ ] At least one parcel where the two paths give different recommended outcomes, and the UI explains why.

---

## 3. Brevard County, FL: Cocoa (future Brightline station)

**Why this locale:** It proves the app works where CoStar has no data, and it is the hardest transit case.
- Brevard's bus system has 23 fixed routes; many run once an hour, and only four run on Sundays ([Florida Today via Yahoo](https://www.yahoo.com/news/brevards-space-coast-area-transit-090139794.html)).
- A Brightline station in Cocoa secured $57.5 million in federal funding, with a potential opening around 2030 ([Spectrum News 13](https://mynews13.com/fl/orlando/news/2026/10/06/-million-grant-advances-brightline-station-in-cocoa)).
- The station area sits beside the Indian River, so flood exposure matters.

**Area:** About 2 miles around the planned Cocoa station site. `TODO(kickoff)`: get the station location from a public source and record it in the fixture with its URL.

**What it tests:**
- Resolver fallback: county parcels, public imagery and footprints, LODES, Space Coast Area Transit GTFS, FEMA, OSM. Confidence badges are medium, not high.
- Missing data handled honestly: no leases, no interiors, no building attributes beyond the county record. The land deal agent must say "lease status unknown, verify before outreach." The building reuse agent must limit itself to what county data supports, and label results as low confidence.
- Transit network design from a thin base: feeder routes to a station that doesn't exist yet, phased to its opening.
- Infrastructure gaps: sidewalks, bike lanes and utilities are likelier to be missing, so the infrastructure agent's gap list should be substantive.
- Flood: no new homes inside FEMA high-risk zones.

**Validation:**
- [ ] No value in the Brevard plan has source `costar`.
- [ ] Every lease-dependent output carries a missing-data note.
- [ ] Flood exposure for new homes is 0%.
- [ ] The transit plan improves frequency on at least one existing route rather than only adding new ones.

---

## Fixtures and golden tests

- `backend/fixtures/<locale>/` holds recorded responses for every provider used in that locale, plus `locale.yaml` (bounding box, station points, jurisdiction, data tier, purpose sentence).
- `backend/tests/locales/test_<locale>.py` holds the validation checklist above as automated tests where possible. Backtests that need an address from CoStar are skipped with a clear reason until the address is filled in.
- Adding a fourth locale requires a purpose that none of these three covers. Write it in this file first.
