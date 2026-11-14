"""Agent 5: utilities scout. For a city (registry place) or a county, finds public water-main and sewer-main layers
(or service-area polygons). Code drops any layer that is not a line/polygon layer, whose `where` errors, or that has
no feature in the area box; the rest are written to the registry `utilities` section."""
from backend.onboard import registry
from backend.onboard.arcgis import arcgis_query, layer_info, oid_field, probe_tools
from backend.onboard.common import MAX_PROBES, check_tool, forget, log_reject, run_agent, stamp

GEOMETRIES = ("esriGeometryPolyline", "esriGeometryPolygon")


def check_layer(lyr, box) -> tuple[list[str], dict]:
    url = lyr.url.rstrip("/")
    try:
        info = layer_info(url)
    except Exception as e:
        return [f"{url}: unreachable ({type(e).__name__})"], {}
    if info.get("geometryType") not in GEOMETRIES:
        return [f"{url}: geometryType {info.get('geometryType')}, not lines or polygons"], {}
    oid = oid_field(info)
    try:
        feats = arcgis_query(url, box, where=lyr.where, out_fields=oid, geometry=False, max_features=1, page=1,
                             order_by=oid)
    except Exception as e:
        return [f"{url}: where/query failed ({str(e)[:150]})"], {}
    if not feats:
        return [f"{url}: no feature in the area box"], {}
    return [], ({"oid_field": oid} if oid != "OBJECTID" else {})


def verify(proposal, box) -> tuple[list[dict], list[str]]:
    """(passing layers as registry entries, problems of the dropped ones)."""
    keep, problems = [], []
    for lyr in proposal.layers:
        p, extra = check_layer(lyr, box)
        if p:
            problems += p
        else:
            keep.append({"kind": lyr.kind, "url": lyr.url.rstrip("/"), "where": lyr.where, "label": lyr.label, **extra})
    return keep, problems


def ensure_utilities(kind: str, geoid: str, name: str, fips: str, box, *, model=None, search=None) -> dict:
    from backend.schemas import UtilitiesProposal
    st = registry.state(fips[:2])
    key = f"utilities-{geoid}"

    def dry(p: dict) -> list[str]:
        return verify(UtilitiesProposal.model_validate(p), box)[1]
    check = check_tool("check_utilities", "Dry-run the code checks on a candidate UtilitiesProposal: layers that "
                       "fail are listed (they would be dropped). Saves nothing.", dry)
    msg = (f"Target: {name}, {st['name']} ({kind} {geoid})\n"
           f"Area box (lon/lat WGS84): {', '.join(f'{v:.5f}' for v in box)}\nKinds wanted: water_main, sewer_main")
    res = run_agent("utilities_scout", key, fips, probe_tools(box, MAX_PROBES) + [check], UtilitiesProposal, msg,
                    model=model, search=search)
    if res is None:
        return {}
    layers, problems = verify(res, box)
    if problems:
        log_reject(key, "utilities_scout", res, problems)
    section = (stamp("agent_verified", model, layers=layers) if layers else
               stamp("not_found", model, layers=[], reason="; ".join(problems or res.not_found or ["none found"])[:300]))
    if not layers:
        forget("utilities_scout", key)
    data = registry.place(geoid) if kind == "place" else registry.county(geoid)
    data["utilities"] = section
    (registry.save_place if kind == "place" else registry.save_county)(geoid, data)
    return section
