---
name: open-data-portals
description: How to get from an ArcGIS Hub, Socrata or CKAN open-data dataset page to the underlying ArcGIS REST layer URL the code can query. Use when a search result is a data portal page rather than a /rest/services URL.
---

# Open-data portals

The recording code reads ArcGIS REST layers only. A portal page is a pointer, not the answer.

## ArcGIS Hub (`hub.arcgis.com`, `data-<county>.opendata.arcgis.com`, `<city>-<org>.hub.arcgis.com`)
- Dataset pages have an "I want to use this" / "View API Resources" panel listing a GeoService URL ending in
  `/FeatureServer/<id>` or `/MapServer/<id>`. Fetch the page and grep for `rest/services`.
- The dataset id in the URL (`…/datasets/<itemId>_<layer>`) has an item page at
  `https://www.arcgis.com/home/item.html?id=<itemId>` whose "URL" field is the service.

## Socrata (`data.<city>.gov`, `*.data.socrata.com`)
- Socrata serves its own API (`/resource/<id>.json`), which this code does not read. Look on the same city's
  site for an ArcGIS server with the same layer, or report not found. Never propose a Socrata URL as a layer.

## CKAN / state portals
- Resources often link to an ArcGIS REST service; use that link. A shapefile or CSV download is not usable.

## Checks before answering
- Probe the URL with `arcgis_layer`: it must answer JSON with a fields list.
- Records must exist inside the sample box (`arcgis_sample`). A statewide layer is fine if it has this county's
  parcels with the needed fields.
