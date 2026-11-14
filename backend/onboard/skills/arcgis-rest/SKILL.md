---
name: arcgis-rest
description: How to find a county's or city's ArcGIS REST server, walk its /rest/services directory, pick a MapServer or FeatureServer layer URL, read its fields and write a `where` clause. Use for parcel, zoning and utility layers.
---

# ArcGIS REST services

Most US counties and cities publish GIS data through ArcGIS Server or ArcGIS Online. Every layer has a REST URL
that the recording code queries directly, so the answer must be a **layer URL**:
`https://<host>/<instance>/rest/services/<Folder>/<Service>/MapServer/<layer id>` (or `FeatureServer/<id>`).

## Finding the server
- Search: `"<county name>" county GIS parcels rest services`, `"<city>" zoning MapServer`, `<county> open data parcels`.
- Common hosts: `gis.<county>.gov`, `maps.<city>.gov`, `services<N>.arcgis.com/<orgId>/arcgis/rest/services`.
- An ArcGIS Hub / open-data page links to the service ("View API resources", "GeoService", "I want to use this").
- A web map viewer's page source often names its services; search results sometimes show the `/rest/services` URL.

## Walking the directory
- `arcgis_service(".../rest/services")` lists folders and services; descend into a folder, then a service.
- A MapServer/FeatureServer lists its layers by id. Parcels are usually `Parcels`, `Tax Parcels`, `Cadastral`.
  Zoning: `Zoning`, `Zoning Districts`. Sewer: `Gravity Mains`, `Sewer Lines`; water: `Water Mains`, `Distribution Mains`.
- Prefer the layer with the most attributes (owner, situs address, use code, values), not a cached basemap.
- Prefer a public, no-token service. A `token required` / `499` error means it is not usable.

## Reading a layer
- `arcgis_layer(url)`: geometryType must be `esriGeometryPolygon` for parcels and zoning; polylines (or service-area
  polygons) for utilities.
- Field names are case-sensitive and must be copied exactly from the list. Aliases are for reading only.
- `arcgis_sample(url, where, out_fields)` shows real values: check the id looks unique, the address is a street
  address, the use code is filled.

## where clauses
- SQL-92 on attribute fields: `STATUS = 'A'`, `SUBTYPE IN (1,2)`, `FIELD IS NULL OR FIELD = 0`.
- Use `1=1` unless the layer mixes records you must drop (stacked condo polygons, retired parcels, private mains).
