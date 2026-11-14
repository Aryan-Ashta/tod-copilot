"""County parcel layers as config: a field-expression DSL (registry `parcels.fields`) that turns one raw ArcGIS
feature's properties into TOD Copilot's parcel properties.

FieldExpr: exactly one operator (field | number | sum | join | epoch_ms_year | year | first) plus modifiers
(strip, zero_is_null, null_values, append, append_separator, min_exclusive, require). docs/12 §14.
"""
import math
from datetime import datetime, timezone
from typing import Any

PARCEL_PROPS = ("id", "address", "owner", "last_sale_usd", "last_sale_year", "assessed_value_usd", "area_acres",
                "raw_use", "raw_use_desc", "raw_code", "year_built", "building_sqft", "units", "city")
BASE_PROPS = tuple(p for p in PARCEL_PROPS if p != "raw_code")   # raw_code only when the county maps it
OPERATORS = ("field", "number", "sum", "join", "epoch_ms_year", "year", "first")


def ms_year(v):
    if v in (None, "", 0):
        return None
    try:
        return datetime.fromtimestamp(int(v) / 1000, tz=timezone.utc).year
    except (TypeError, ValueError, OSError):
        return None


def num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def join(*parts) -> str:
    return " ".join(str(p).strip() for p in parts if p not in (None, "", 0) and str(p).strip())


def referenced_fields(expr: dict) -> list[str]:
    """Every source field name an expression reads."""
    out = []
    for k in ("field", "number", "epoch_ms_year", "year", "append", "require"):
        if expr.get(k):
            out.append(expr[k])
    for k in ("sum", "join", "first"):
        out += list(expr.get(k) or [])
    return out


def _nulls(expr: dict) -> set[str]:
    return {str(v).strip().upper() for v in expr.get("null_values") or []}


def _missing(v, nulls: set[str]) -> bool:
    return v is None or str(v).strip() == "" or str(v).strip().upper() in nulls


def eval_expr(expr: dict, p: dict) -> Any:
    nulls = _nulls(expr)
    if (req := expr.get("require")) is not None:
        if _missing(p.get(req), nulls):
            return None
        if ("number" in expr or "sum" in expr) and num(p.get(req)) is None:
            return None
    if "field" in expr:
        v = p.get(expr["field"])
        if expr.get("strip"):
            return (str(v).strip() or None) if v is not None else None
        return v
    if "number" in expr:
        x = num(p.get(expr["number"]))
        return (x or None) if expr.get("zero_is_null") else x
    if "sum" in expr:
        xs = [num(p.get(f)) for f in expr["sum"]]
        return None if all(x is None for x in xs) else sum(x or 0 for x in xs)
    if "join" in expr:
        vals = [None if _missing(p.get(f), nulls) else p.get(f) for f in expr["join"]]
        joined = join(*vals)
        if not joined:
            return None
        if expr.get("append"):
            return f"{joined}{expr.get('append_separator', ', ')}{p.get(expr['append'])}"
        return joined
    if "epoch_ms_year" in expr:
        return ms_year(p.get(expr["epoch_ms_year"]))
    if "year" in expr:
        v = p.get(expr["year"])
        if v and str(v).strip().isdigit() and int(v) > expr.get("min_exclusive", 0):
            return int(v)
        return None
    if "first" in expr:
        return next((p.get(f) for f in expr["first"] if p.get(f)), None)
    raise ValueError(f"field expression has no operator: {expr}")


def normalize(fields: dict[str, dict], p: dict) -> dict:
    """Raw feature properties -> BASE_PROPS (+ raw_code when mapped) + zoning_code (filled later), in PARCEL_PROPS
    order so recorded geojson stays byte-stable."""
    out = {k: (eval_expr(fields[k], p) if k in fields else None) for k in PARCEL_PROPS
           if k != "raw_code" or "raw_code" in fields}
    out["id"] = str(out["id"])
    out["zoning_code"] = None
    return out


# ---------------------------------------------------------------- agent 1: parcel source scout
REQUIRED = ("id", "address")
POLYGON = "esriGeometryPolygon"
NUMBER_PROPS = ("last_sale_usd", "assessed_value_usd", "area_acres", "building_sqft", "units")
YEAR_PROPS = ("last_sale_year", "year_built")
ACRES_RATIO = (0.5, 2.0)   # mapped area_acres vs the polygon's own area: catches square feet passed off as acres


def _year_ok(v, hi: int) -> bool:
    return 1800 <= v <= hi


def verify(proposal, box) -> tuple[bool, list[str], dict]:
    """Check a ParcelSourceProposal against the live layer in the sample box: (ok, problems, registry section)."""
    import re as _re
    from backend.onboard.arcgis import arcgis_query, field_names, layer_info, oid_field
    from backend.onboard.common import thresholds
    if proposal.status == "not_found":
        ok = bool((proposal.reason or "").strip())
        return ok, [] if ok else ["not_found needs a reason"], {"reason": proposal.reason}
    url = (proposal.layer_url or "").rstrip("/")
    if not _re.search(r"/(MapServer|FeatureServer)/\d+$", url):
        return False, ["layer_url must end in /MapServer/<id> or /FeatureServer/<id>"], {}
    try:
        info = layer_info(url)
    except Exception as e:
        return False, [f"layer unreachable: {type(e).__name__}: {str(e)[:200]}"], {}
    problems = []
    if info.get("geometryType") != POLYGON:
        problems.append(f"geometryType is {info.get('geometryType')}, not {POLYGON}")
    fields = {k: v.model_dump(exclude_none=True) for k, v in proposal.fields.items()}
    unknown_props = set(fields) - set(PARCEL_PROPS)
    if unknown_props:
        problems.append(f"unknown parcel properties {sorted(unknown_props)}; use {list(PARCEL_PROPS)}")
    have = field_names(info)
    missing = sorted({f for e in fields.values() for f in referenced_fields(e)} - have)
    if missing:
        problems.append(f"fields not in the layer: {missing}")
    for k in REQUIRED:
        if k not in fields:
            problems.append(f"{k} is not mapped")
    if "raw_use" not in fields and "raw_use_desc" not in fields:
        problems.append("neither raw_use nor raw_use_desc is mapped")
    for k in NUMBER_PROPS:
        if k in fields and not ({"number", "sum"} & set(fields[k])):
            problems.append(f"{k} must use `number` or `sum` (a numeric value), not {sorted(fields[k])}")
    for k in YEAR_PROPS:
        if k in fields and not ({"year", "epoch_ms_year"} & set(fields[k])):
            problems.append(f"{k} must use `year` or `epoch_ms_year`, not {sorted(fields[k])}")
    if problems:
        return False, problems, {}
    t = thresholds()
    oid = oid_field(info)
    try:
        feats = arcgis_query(url, box, proposal.where, max_features=200, page=200, order_by=oid)
    except Exception as e:
        return False, [f"query failed: {str(e)[:200]}"], {}
    if len(feats) < t["onboard_parcel_min_sample"]:
        return False, [f"{len(feats)} parcels in the sample box; need {t['onboard_parcel_min_sample']}"], {}
    rows = [normalize(fields, f.get("properties") or {}) for f in feats]
    n = len(rows)
    ids = [r["id"] for r in rows if r["id"] not in ("None", "")]
    id_share = len(set(ids)) / n
    if id_share < t["onboard_parcel_id_share"]:
        problems.append(f"id unique share {id_share:.2f} < {t['onboard_parcel_id_share']}")
    addr = sum(1 for r in rows if r["address"]) / n
    if addr < t["onboard_parcel_address_share"]:
        problems.append(f"address share {addr:.2f} < {t['onboard_parcel_address_share']}")
    use = sum(1 for r in rows if r.get("raw_use") or r.get("raw_use_desc")) / n
    if use < t["onboard_parcel_use_share"]:
        problems.append(f"use code share {use:.2f} < {t['onboard_parcel_use_share']}")
    hi = datetime.now(timezone.utc).year + 1
    yb = [r["year_built"] for r in rows if r.get("year_built") is not None]
    if yb and sum(1 for v in yb if isinstance(v, (int, float)) and _year_ok(v, hi)) / len(yb) < 0.95:
        problems.append(f"year_built outside 1800-{hi} on more than 5% of parcels")
    av = [r["assessed_value_usd"] for r in rows if r.get("assessed_value_usd") is not None]
    if av and sum(1 for v in av if isinstance(v, (int, float)) and v >= 0) / len(av) < 0.95:
        problems.append("assessed_value_usd is not a non-negative number on more than 5% of parcels")
    if "area_acres" in fields:
        from statistics import median
        from backend.data.areas import utm_epsg
        from backend.data.geo import area_acres
        epsg = utm_epsg((box[0] + box[2]) / 2, (box[1] + box[3]) / 2)
        ratios = [r["area_acres"] / a for r, f in zip(rows, feats) if f.get("geometry") and r.get("area_acres")
                  and (a := area_acres(f["geometry"], epsg)) > 0]
        if ratios and not ACRES_RATIO[0] <= median(ratios) <= ACRES_RATIO[1]:
            problems.append(f"area_acres is {median(ratios):.0f}x the polygon area: the field is not in acres; "
                            "leave area_acres unmapped (the code computes it from the polygon)")
    coverage = {k: round(sum(1 for r in rows if r.get(k) not in (None, "", "None")) / n, 2) for k in fields}
    section = {"url": url, "where": proposal.where, "fields": fields, "notes": dict(proposal.notes),
               "coverage": coverage, "evidence_url": proposal.evidence_url}
    if oid != "OBJECTID":
        section["oid_field"] = oid
    return not problems, problems, section


def ensure_parcels(fips: str, box, *, model=None, search=None) -> dict:
    """Run the parcel source scout for a county and write its `parcels` section when verified. Returns the
    section written, or {} when the final proposal was rejected (logged; retried next time)."""
    from backend.onboard import registry
    from backend.onboard.arcgis import probe_tools
    from backend.onboard.common import MAX_PROBES, check_tool, forget, log_reject, run_agent, stamp
    from backend.schemas import ParcelSourceProposal
    c = registry.county(fips)
    st = registry.state(fips[:2])

    def dry(p: dict) -> list[str]:
        return verify(ParcelSourceProposal.model_validate(p), box)[1]
    check = check_tool("check_parcel_source", "Dry-run the code checks on a candidate ParcelSourceProposal (same "
                       "fields as your final answer). Saves nothing; returns the problems or 'passes'.", dry)
    msg = (f"County: {c.get('name')}, {st['name']} (FIPS {fips})\nSample box (lon/lat WGS84): "
           f"{', '.join(f'{v:.5f}' for v in box)}\nSample point: {(box[0] + box[2]) / 2:.5f}, "
           f"{(box[1] + box[3]) / 2:.5f}\nParcel properties: {', '.join(PARCEL_PROPS)}")
    res = run_agent("parcel_scout", f"parcels-{fips}", fips, probe_tools(box, MAX_PROBES) + [check],
                    ParcelSourceProposal, msg, model=model, search=search)
    if res is None:
        return {}
    ok, problems, section = verify(res, box)
    if not ok:
        log_reject(f"parcels-{fips}", "parcel_scout", res, problems)
        forget("parcel_scout", f"parcels-{fips}")
        return {}
    section = stamp("agent_verified" if res.status == "found" else "not_found", model, **section)
    c = registry.county(fips)
    c["parcels"] = section
    registry.save_county(fips, c)
    return section
