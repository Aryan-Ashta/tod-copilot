"""ArcGIS REST queries (cached) and the probe tools onboarding agents use to inspect county and city GIS servers."""
import json
from typing import Callable, Optional

from backend.data.http_cache import cached_get, evict

BUDGET_SPENT = "probe budget spent: no more GIS requests. Dry-run what you have with the check tool, then answer"


def _envelope(bbox) -> dict:
    return {"geometry": ",".join(f"{v:.6f}" for v in bbox), "geometryType": "esriGeometryEnvelope", "inSR": 4326}


def query_params(bbox, where: str = "1=1", out_fields: str = "*", geometry: bool = True, order_by: str = "OBJECTID",
                 offset: int = 0, page: int = 1000) -> dict:
    """The /query parameters of one arcgis_query page (the HTTP cache key)."""
    return {**_envelope(bbox), "outSR": 4326, "spatialRel": "esriSpatialRelIntersects", "where": where,
            "outFields": out_fields, "returnGeometry": str(geometry).lower(), "f": "geojson",
            "orderByFields": order_by, "resultOffset": offset, "resultRecordCount": page}


def arcgis_query(url: str, bbox, where: str = "1=1", out_fields: str = "*", geometry: bool = True,
                 page: int = 1000, max_features: Optional[int] = None, order_by: str = "OBJECTID") -> list[dict]:
    feats, offset = [], 0
    while True:
        params = query_params(bbox, where, out_fields, geometry, order_by, offset, page)
        d = cached_get(f"{url}/query", params)
        if "error" in d:
            evict(f"{url}/query", params)
            raise RuntimeError(f"{url}: {d['error']}")
        batch = d.get("features", [])
        feats += batch
        if max_features is not None and len(feats) >= max_features:
            return feats[:max_features]
        exceeded = d.get("exceededTransferLimit") or d.get("properties", {}).get("exceededTransferLimit")
        if not exceeded or not batch:
            return feats
        offset += len(batch)


def arcgis_count(url: str, bbox, where: str = "1=1") -> int:
    params = {**_envelope(bbox), "where": where, "returnCountOnly": "true", "f": "json"}
    return cached_get(f"{url}/query", params)["count"]


def layer_info(url: str) -> dict:
    """The layer's JSON description (?f=json); raises RuntimeError on an ArcGIS error body."""
    url = url.rstrip("/")
    d = cached_get(url, {"f": "json"})
    if "error" in d:
        evict(url, {"f": "json"})
        raise RuntimeError(f"{url}: {d['error']}")
    return d


def field_names(info: dict) -> set[str]:
    return {f["name"] for f in info.get("fields") or []}


def oid_field(info: dict) -> str:
    """The layer's object-id field (paging order); OBJECTID when the layer does not say."""
    return info.get("objectIdField") or next((f["name"] for f in info.get("fields") or []
                                              if f.get("type") == "esriFieldTypeOID"), "OBJECTID")


def sample_params(bbox, where: str = "1=1", out_fields: str = "*", n: int = 5) -> dict:
    return {**_envelope(bbox), "spatialRel": "esriSpatialRelIntersects", "where": where, "outFields": out_fields,
            "returnGeometry": "false", "resultRecordCount": n, "f": "json"}


def sample_records(url: str, bbox, where: str = "1=1", out_fields: str = "*", n: int = 5) -> list[dict]:
    """Up to n attribute records inside the bbox (no geometry)."""
    params = sample_params(bbox, where, out_fields, n)
    d = cached_get(f"{url.rstrip('/')}/query", params)
    if "error" in d:
        evict(f"{url.rstrip('/')}/query", params)
        raise RuntimeError(f"{url}: {d['error']}")
    return [f.get("attributes") or {} for f in d.get("features") or []][:n]


def probe_tools(bbox, budget: int = 20) -> list[Callable]:
    """GIS probe tools for onboarding agents, sharing one request budget; bbox is the sample box records come from."""
    used = [0]

    def spend() -> Optional[str]:
        if used[0] >= budget:
            return f"{BUDGET_SPENT} ({budget} requests used)"
        used[0] += 1
        return None

    def arcgis_service(url: str) -> str:
        """List an ArcGIS REST directory, folder or service (…/rest/services, …/rest/services/<Folder>,
        …/MapServer, …/FeatureServer): its folders, services and layers (id, name, type)."""
        if (msg := spend()):
            return msg
        try:
            d = cached_get(url.rstrip("/"), {"f": "json"})
        except Exception as e:
            return f"error: {type(e).__name__}: {str(e)[:200]}"
        if "error" in d:
            return f"error: {json.dumps(d['error'])[:300]}"
        lines = [f"folder {f}" for f in d.get("folders") or []]
        lines += [f"service {s.get('name')} ({s.get('type')})" for s in d.get("services") or []]
        lines += [f"layer {lyr.get('id')}: {lyr.get('name')} ({lyr.get('type') or lyr.get('geometryType') or ''})"
                  for lyr in (d.get("layers") or []) + (d.get("tables") or [])]
        return "\n".join(lines[:60]) + (f"\n… {len(lines) - 60} more" if len(lines) > 60 else "") or "empty"

    def arcgis_layer(url: str) -> str:
        """Describe one layer (…/MapServer/<id> or …/FeatureServer/<id>): name, geometry type, max record count and
        its fields as name:type:alias. Use the exact field names it lists; never invent one."""
        if (msg := spend()):
            return msg
        try:
            d = layer_info(url)
        except Exception as e:
            return f"error: {type(e).__name__}: {str(e)[:200]}"
        fields = [f"{f['name']}:{f.get('type', '').removeprefix('esriFieldType')}:{f.get('alias') or ''}"
                  for f in (d.get("fields") or [])[:120]]
        return (f"name: {d.get('name')}\ngeometryType: {d.get('geometryType')}\nmaxRecordCount: "
                f"{d.get('maxRecordCount')}\nfields ({len(d.get('fields') or [])}):\n" + "\n".join(fields))

    def arcgis_sample(url: str, where: str = "1=1", out_fields: str = "*") -> str:
        """Up to 5 records of a layer inside the sample box, attributes only, as JSON lines. Use it to see real
        values of candidate fields (ids, addresses, use codes, zoning codes)."""
        if (msg := spend()):
            return msg
        try:
            recs = sample_records(url, bbox, where, out_fields)
        except Exception as e:
            return f"error: {type(e).__name__}: {str(e)[:200]}"
        return "\n".join(json.dumps(r, default=str)[:1500] for r in recs) or "no records in the sample box"

    return [arcgis_service, arcgis_layer, arcgis_sample]
