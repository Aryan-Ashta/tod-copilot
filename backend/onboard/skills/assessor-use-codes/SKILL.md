---
name: assessor-use-codes
description: How to find and read a county assessor's land-use / property-class / state-class code table (HTML or PDF) and map each code to TOD Copilot's land-use vocabulary.
---

# Assessor use codes

Parcels carry a use code (`state_class`, `USE_CODE`, `LAND_USE`, `PROP_CLASS`) and often a description. The map
turns each observed value into one of: office, retail, hotel, industrial, parking_garage, surface_parking,
residential, public, vacant, other.

## Finding the code list
- Search `"<county>" assessor property class codes`, `"<county>" land use codes pdf`, `<state> property tax
  classification codes` (many states define the codes statewide: Florida DOR use codes, Texas PTAD state codes).
- Fetch the page or PDF with `fetch_page`; the verifier checks that the observed codes appear on it verbatim.
  Pick the page that lists **these** codes (the values you were given), not a different scheme.

## Mapping rules
- Map by the code's meaning on the page, never by guessing from the letters.
- Office: office buildings, professional/medical office. Retail: stores, restaurants, banks, service stations,
  general commercial. Hotel: hotels, motels. Industrial: manufacturing, warehouses. Parking: garages →
  parking_garage, lots → surface_parking. Residential: single family, condos, apartments, mobile homes.
  Public: government, schools (public), utilities, railroads. Vacant: vacant land of any kind.
  Other: churches, private schools, agriculture, cemeteries, water, anything unclear.
- `default` is the vocabulary value for codes not in the map (usually `other`).
- `building_type_reliable: false` when the codes lump uses together (one "commercial" class for office and retail).
- `vacant_code_suffix`: only when the page says a code suffix marks vacant land (e.g. LA's trailing `V`).
- Use the description field (`raw_use_desc`) when its values are readable; the code field otherwise.
