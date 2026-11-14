"""Agent 3: zoning layer scout. For a city (registry place) or a county (unincorporated land), finds the public
zoning-district polygon layer and its district-code field, or official text saying the place has no zoning. Code
samples the layer before anything is written to the registry `zoning` section."""
from functools import lru_cache
from pathlib import Path

import yaml

from backend.onboard import registry
from backend.onboard.arcgis import arcgis_query, field_names, layer_info, oid_field, probe_tools
from backend.onboard.common import (MAX_PROBES, check_tool, forget, log_reject, run_agent, stamp, thresholds)
from backend.research import pages
from backend.research.registry import domain

POLYGON = "esriGeometryPolygon"
LEGAL_DOMAINS_PATH = Path(__file__).resolve().parent / "legal_domains.yaml"


@lru_cache(maxsize=1)
def legal_domains() -> tuple[str, ...]:
    return tuple(yaml.safe_load(LEGAL_DOMAINS_PATH.read_text()))


def official(url: str) -> bool:
    host = domain(url)
    return any(host.endswith(d) if d.startswith(".") else host == d or host.endswith("." + d)
               for d in legal_domains())


def quote_on_page(url: str, quote: str) -> bool:
    page = pages.cached_page(url)
    return page is not None and bool(quote) and pages.normalize(quote) in pages.normalize(page.full)


def check_layer(url: str, field: str, box) -> tuple[list[str], dict]:
    """Problems with one zoning layer in the box, and its registry entry extras (oid_field)."""
    try:
        info = layer_info(url)
    except Exception as e:
        return [f"{url}: unreachable ({type(e).__name__})"], {}
    if info.get("geometryType") != POLYGON:
        return [f"{url}: geometryType {info.get('geometryType')}, not {POLYGON}"], {}
    if field not in field_names(info):
        return [f"{url}: no field {field!r}"], {}
    oid = oid_field(info)
    try:
        feats = arcgis_query(url, box, out_fields=field, geometry=False, max_features=200, page=200, order_by=oid)
    except Exception as e:
        return [f"{url}: query failed ({str(e)[:150]})"], {}
    if not feats:
        return [f"{url}: no polygon in the area box"], {}
    vals = [str((f.get("properties") or {}).get(field) or "").strip() for f in feats]
    share = sum(1 for v in vals if v) / len(vals)
    need = thresholds()["onboard_zoning_field_share"]
    problems = []
    if share < need:
        problems.append(f"{url}: {field} filled on {share:.0%} of polygons (need {need:.0%})")
    if len({v for v in vals if v}) < 2:
        problems.append(f"{url}: {field} has fewer than 2 distinct codes; not a zoning-district field")
    return problems, ({"oid_field": oid} if oid != "OBJECTID" else {})


def verify(proposal, box, prefix: str = "") -> tuple[bool, list[str], dict]:
    """(ok, problems, section). County layers get `prefix` (the county name) so their codes never match a city's."""
    if proposal.status == "not_found":
        return True, [], {}
    if proposal.status == "no_zoning":
        problems = []
        if not proposal.evidence_url or pages.cached_page(proposal.evidence_url) is None:
            problems.append("evidence_url was not fetched")
        elif not official(proposal.evidence_url):
            problems.append(f"{domain(proposal.evidence_url)} is not an official (.gov/.us or code publisher) site")
        elif not quote_on_page(proposal.evidence_url, proposal.quote or ""):
            problems.append("quote is not on the evidence page")
        if "zoning" not in (proposal.quote or "").lower():
            problems.append("quote must say the place has no zoning (contain 'zoning')")
        return not problems, problems, {"none": True, "note": (proposal.quote or "").strip(),
                                        "evidence_url": proposal.evidence_url}
    if not proposal.layers:
        return False, ["found needs at least one layer"], {}
    problems, layers = [], []
    for lyr in proposal.layers:
        p, extra = check_layer(lyr.url.rstrip("/"), lyr.field, box)
        problems += p
        layers.append({"url": lyr.url.rstrip("/"), "field": lyr.field, "label": lyr.label,
                       "prefix": prefix or lyr.prefix, **extra})
    return not problems, problems, {"layers": layers}


def ensure_zoning(kind: str, geoid: str, name: str, fips: str, box, *, model=None, search=None) -> dict:
    """kind 'place' (geoid = place GEOID) or 'county' (geoid = county FIPS). Writes the `zoning` section."""
    from backend.schemas import ZoningProposal
    st = registry.state(fips[:2])
    prefix = f"{name} " if kind == "county" else ""
    key = f"zoning-{geoid}"

    def dry(p: dict) -> list[str]:
        return verify(ZoningProposal.model_validate(p), box, prefix)[1]
    check = check_tool("check_zoning", "Dry-run the code checks on a candidate ZoningProposal. Saves nothing.", dry)
    scope = ("the city" if kind == "place" else "unincorporated land (county zoning), not a city's layer")
    msg = (f"Target: {name}, {st['name']} ({kind} {geoid}); find the zoning for {scope}\n"
           f"Area box (lon/lat WGS84): {', '.join(f'{v:.5f}' for v in box)}")
    res = run_agent("zoning_scout", key, fips, probe_tools(box, MAX_PROBES) + [check], ZoningProposal, msg,
                    model=model, search=search)
    if res is None:
        return {}
    ok, problems, section = verify(res, box, prefix)
    if not ok:
        log_reject(key, "zoning_scout", res, problems)
        forget("zoning_scout", key)
        return {}
    status = "not_found" if res.status == "not_found" else "agent_verified"
    data = registry.place(geoid) if kind == "place" else registry.county(geoid)
    data["zoning"] = stamp(status, model, **section)
    (registry.save_place if kind == "place" else registry.save_county)(geoid, data)
    return data["zoning"]
