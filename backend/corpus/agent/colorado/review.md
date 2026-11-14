# Agent-built legal corpus: Colorado (colorado)

Agent-built, code-checked (official host, verbatim sections, verbatim quotes, numbers in quotes). Used in plans now, labeled agent-verified. A person reviews every rule against its quote and approves with `uv run python scripts/review_corpus.py colorado --approve`.

## Accepted rules (5)

- **Colorado HB 24-1304 parking minimums near transit** `eligible` = `True` if `{'distance_to_stop_mi': {'lte': 0.25}}`
  - co_hb24_1304_signed / 29-36-106. Applicable transit service areas map.: “(a) ONE-QUARTER MILE OF EXISTING STATIONS SERVED BY ROUTES
IDENTIFIED IN AN APPLICABLE TRANSIT PLAN FOR:
(I) COMMUTER BUS RAPID TRANSIT;
(II) COMMUTER RAIL WITH PLANNED OR SCHEDULED SERVICE THAT
IS SCHEDULED TO RUN EVERY THIRTY MINUTES OR MORE FREQUENT
BETWEEN SEVEN A.M. AND TEN A.M. AND BETWEEN FOUR P.M. AND SEVEN
P.M.;
(III) LIGHT RAIL WITH PLANNED OR SCHEDULED SERVICE THAT IS
SCHEDULED TO RUN EVERY THIRTY MINUTES OR MORE FREQUENT BETWEEN
SEVEN A.M. AND TEN A.M. AND BETWEEN FOUR P.M. AND SEVEN P.M.”
- **Colorado HB 24-1304 parking minimums near transit** `parking_min_per_unit` = `1` if `{'est_units': {'gte': 20}}`
  - co_hb24_1304_signed / 29-36-104. Limitations on minimum parking requirements for housing developments of 20+ units.: “NOTWITHSTANDING SECTION 29-36-103, A LOCAL GOVERNMENT MAY
IMPOSE OR ENFORCE A MINIMUM PARKING REQUIREMENT IN CONNECTION
WITH A HOUSING DEVELOPMENT PROJECT THAT IS INTENDED TO CONTAIN
TWENTY UNITS OR MORE OR CONTAIN REGULATED AFFORDABLE HOUSING BY
REQUIRING NO MORE THAN ONE PARKING SPACE PER DWELLING UNIT IN THE
HOUSING DEVELOPMENT.
(2) (a) IN ORDER TO IMPOSE A MINIMUM PARKING REQUIREMENT
PURSUANT TO SUBSECTION (1) OF THIS SECTION IN CONNECTION WITH A
HOUSING DEVELOPMENT PROJECT, A LOCAL GOVERNMENT MUST, NO LATER
THAN NINETY DAYS AFTER RECEIVING A COMPLETED APPLICATION FOR THE
HOUSING DEVELOPMENT PROJECT, PUBLICLY PUBLISH WRITTEN FINDINGS
THAT FIND THAT NOT IMPOSING OR ENFORCING A MINIMUM PARKING
REQUIREMENT IN CONNECTION WITH THE HOUSING DEVELOPMENT PROJECT
WOULD HAVE A SUBSTANTIAL NEGATIVE IMPACT.”
- **Colorado HB 24-1304 parking minimums near transit** `allows_uses` = `['residential', 'mixed_use']`
  - co_hb24_1304_signed / 29-36-103. Limitations on minimum parking requirements.: “A MUNICIPALITY SHALL NEITHER ENACT
NOR ENFORCE LOCAL LAWS THAT ESTABLISH A MINIMUM PARKING
REQUIREMENT THAT APPLIES TO A LAND USE APPROVAL FOR A MULTIFAMILY
RESIDENTIAL DEVELOPMENT, ADAPTIVE RE-USE FOR RESIDENTIAL PURPOSES,
OR ADAPTIVE RE-USE MIXED-USE PURPOSES WHICH INCLUDE AT LEAST FIFTY
PERCENT OF USE FOR RESIDENTIAL PURPOSES”
- **Colorado HB 24-1304 parking minimums near transit** `approval_steps` = `TODO`
  - co_hb24_1304_signed / 29-36-104. Limitations on minimum parking requirements for housing developments of 20+ units.: “A LOCAL GOVERNMENT MUST, NO LATER
THAN NINETY DAYS AFTER RECEIVING A COMPLETED APPLICATION FOR THE
HOUSING DEVELOPMENT PROJECT, PUBLICLY PUBLISH WRITTEN FINDINGS
THAT FIND THAT NOT IMPOSING OR ENFORCING A MINIMUM PARKING
REQUIREMENT IN CONNECTION WITH THE HOUSING DEVELOPMENT PROJECT
WOULD HAVE A SUBSTANTIAL NEGATIVE IMPACT.”
- **Colorado HB 24-1304 parking minimums near transit** `note` = `Colorado HB 24-1304 bans minimum parking requirements for multifamily residential development and adaptive reuse for residential purposes at or partially within applicable transit service areas (within 0.25 mi of qualifying transit stations and bus routes) on or after June 30, 2025.`
  - co_hb24_1304_signed / 29-36-103. Limitations on minimum parking requirements.: “ON OR AFTER JUNE 30, 2025, A MUNICIPALITY SHALL NEITHER ENACT
NOR ENFORCE LOCAL LAWS THAT ESTABLISH A MINIMUM PARKING
REQUIREMENT THAT APPLIES TO A LAND USE APPROVAL FOR A MULTIFAMILY
RESIDENTIAL DEVELOPMENT, ADAPTIVE RE-USE FOR RESIDENTIAL PURPOSES,
OR ADAPTIVE RE-USE MIXED-USE PURPOSES WHICH INCLUDE AT LEAST FIFTY
PERCENT OF USE FOR RESIDENTIAL PURPOSES THAT IS WITHIN THE
MUNICIPALITY, A METROPOLITAN PLANNING ORGANIZATION, AND AT LEAST
PARTIALLY WITHIN AN APPLICABLE TRANSIT SERVICE AREA.”

## Documents (3)

- co_hb24_1313_signed: Colorado HB 24-1313 (Signed) - Housing in Transit-Oriented Communities (https://content.leg.colorado.gov/sites/default/files/2024a_1313_signed.pdf), 3 sections
- co_hb24_1304_signed: Colorado HB 24-1304 (Signed) - Minimum Parking Requirements within Metropolitan Planning Organizations (https://leg.colorado.gov/sites/default/files/2024a_1304_signed.pdf), 4 sections
- co_crs2024_title29_art20: Colorado Revised Statutes 2024, Title 29, Art. 20 - Local Government Land Use Control (https://content.leg.colorado.gov/sites/default/files/images/olls/crs2024-title-29.pdf), 1 sections

## Rejected by the code checks (23)

- co_hb24_1313_signed / 29-37-204. Transit -oriented community housing opportunity goal calculation.: section text is not verbatim on the fetched page
- co_hb24_1313_signed / 29-37-205. Criteria for qualification as a transit center - criteria for qualification as a transit center outside of a transit area.: section text is not verbatim on the fetched page
- co_hb24_1313_signed / 29-37-207. Transit areas map - transit station area criteria - transit corridor area criteria - housing opportunity goals, models, and guidance.: section text is not verbatim on the fetched page
- co_hb24_1125_intro / 39-22-560. Tax credit for qualified costs incurred in converting commercial structures to residential structures - definitions - repeal.: section text is not verbatim on the fetched page
- co_hb24_1125_intro / 39-22-560. Submission, review, and reservation of tax credits.: section text is not verbatim on the fetched page
- co_hb24_1125_intro / 39-22-560. Issuance and cap of tax credit.: section text is not verbatim on the fetched page
- co_hb24_1125_intro / 39-22-560. Annual limit on tax credit reservations.: section text is not verbatim on the fetched page
- document co_hb24_1125_intro: no verified section
- rule Colorado HB 24-1313 transit-oriented communities / stop_tier: cited section is not a heading of the document
- rule Colorado HB 24-1313 transit-oriented communities / stop_tier: cited section is not a heading of the document
- rule Colorado HB 24-1313 transit-oriented communities / max_units_per_acre: cited section is not a heading of the document
- rule Colorado HB 24-1313 transit-oriented communities / max_units_per_acre: cited section is not a heading of the document
- rule Colorado HB 24-1313 transit-oriented communities / discretionary: cited section is not a heading of the document
- rule Colorado HB 24-1313 transit-oriented communities / approval_steps: cited section is not a heading of the document
- rule Colorado HB 24-1313 transit-oriented communities / note: cited section is not a heading of the document
- rule Colorado HB 24-1304 parking minimums near transit / parking_min_per_unit: 0 does not appear in the quote
- rule Colorado HB 24-1125 commercial-to-residential conversion / eligible: cited document was not accepted
- rule Colorado HB 24-1125 commercial-to-residential conversion / allows_uses: cited document was not accepted
- rule Colorado HB 24-1125 commercial-to-residential conversion / approval_steps: cited document was not accepted
- rule Colorado HB 24-1125 commercial-to-residential conversion / discretionary: cited document was not accepted
- rule Colorado HB 24-1125 commercial-to-residential conversion / note: cited document was not accepted
- path Colorado HB 24-1313 transit-oriented communities: path lacks eligible/allows_uses/approval_steps rules
- path Colorado HB 24-1125 commercial-to-residential conversion: no accepted rule

## Not covered

- Height (ft) and FAR limits for specific commercial and mixed-use zoning districts - Colorado state law does not set these; they are set by each city or county in its own zoning code
- Residential use in commercial and office zones - Colorado state law delegates this to local zoning codes; no state statute prescribes allowed uses by district type
- By-right vs discretionary approval for residential in commercial zones - governed by local codes, not state statute (HB 24-1313 requires administrative approval only within designated transit centers)
- Office-to-residential conversion zoning approval pathway - state law (HB 24-1125) provides only a tax credit; local zoning approval pathway is handled by individual municipal codes
- Density bonus program details - section 29-35-208(d) / 29-37-208(d) directs local governments to establish density bonus programs but does not prescribe the specific bonus amounts or conditions
- HB 24-1125 final enacted text - only the introduced version was available; the signed enrolled version could not be accessed
