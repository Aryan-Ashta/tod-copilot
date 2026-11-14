"""Agent 2: use-code mapper. Maps a county's observed parcel use codes (or descriptions) to TOD Copilot's land-use
vocabulary, from the county's own code list page. Code checks that the page was fetched and that the observed codes
really appear on it (count-weighted), then writes the registry `land_use` section."""
import re
from collections import Counter
from typing import Optional

from backend.onboard import registry
from backend.onboard.arcgis import arcgis_query
from backend.onboard.common import (check_tool, forget, log_reject, run_agent, stamp, thresholds)
from backend.onboard.parcels import normalize
from backend.research import pages

SAMPLE_PARCELS = 2000


def _clean(v) -> str:
    return re.sub(r"\s+", " ", str(v or "").strip())


def observed_codes(parcels: dict, box) -> dict[str, Counter]:
    """{raw_use: Counter, raw_use_desc: Counter} over up to 2000 parcels of the sample box."""
    feats = arcgis_query(parcels["url"], box, parcels.get("where", "1=1"), geometry=False,
                         max_features=SAMPLE_PARCELS, order_by=parcels.get("oid_field", "OBJECTID"))
    out = {"raw_use": Counter(), "raw_use_desc": Counter()}
    for f in feats:
        row = normalize(parcels["fields"], f.get("properties") or {})
        for k in out:
            if k in parcels["fields"] and _clean(row.get(k)):
                out[k][_clean(row.get(k))] += 1
    return out


def preferred_field(parcels: dict) -> str:
    return "raw_use_desc" if "raw_use_desc" in parcels["fields"] else "raw_use"


def _on_page(code: str, text: str) -> bool:
    c = pages.normalize(code)
    if len(c) <= 3:   # short codes ("A1", "F2"): whole token only
        return bool(re.search(rf"(?<![a-z0-9]){re.escape(c)}(?![a-z0-9])", text))
    return c in text


def page_share(codes: Counter, url: str) -> Optional[float]:
    """Count-weighted share of parcels whose code is on the fetched page; None when the page was not fetched."""
    page = pages.cached_page(url)
    if page is None:
        return None
    text = pages.normalize(page.full)
    total = sum(codes.values())
    return sum(n for c, n in codes.items() if _on_page(c, text)) / total if total else 0.0


def verify(proposal, counts: dict[str, Counter], parcels: dict) -> tuple[bool, list[str], dict]:
    problems = []
    if proposal.field not in parcels["fields"]:
        return False, [f"{proposal.field} is not mapped in this county's parcel layer"], {}
    codes = counts[proposal.field]
    if not codes:
        return False, [f"no parcel in the sample has a {proposal.field} value"], {}
    share = page_share(codes, proposal.code_list_url)
    if share is None:
        problems.append("code_list_url was not fetched (fetch it with fetch_page)")
    elif share < (need := thresholds()["onboard_land_use_code_page_share"]):
        problems.append(f"only {share:.0%} of sampled parcels have a code that appears on the code list page "
                        f"(need {need:.0%}); use the page that lists these codes")
    section = {"field": proposal.field, "map": dict(proposal.map), "default": proposal.default,
               "building_type_reliable": proposal.building_type_reliable, "source_url": proposal.code_list_url,
               "note": f"agent-mapped from the code list at {proposal.code_list_url}"}
    if proposal.vacant_code_suffix:
        section["vacant_code_suffix"] = proposal.vacant_code_suffix
    unmapped = sum(n for c, n in codes.items() if c not in proposal.map)
    section["unmapped_share"] = round(unmapped / sum(codes.values()), 3)
    return not problems, problems, section


def _message(c: dict, fips: str, field: str, codes: Counter) -> str:
    st = registry.state(fips[:2])
    return (f"County: {c.get('name')}, {st['name']} (FIPS {fips})\nParcel layer: {c['parcels']['url']}\n"
            f"Field: {field}\nObserved values (count of sampled parcels):\n"
            + "\n".join(f"{code} ({n})" for code, n in codes.most_common()))


def _propose(fips: str, key: str, field: str, codes: Counter, counts: dict, parcels: dict, model, search):
    from backend.schemas import LandUseProposal

    def dry(p: dict) -> list[str]:
        return verify(LandUseProposal.model_validate(p), counts, parcels)[1]
    check = check_tool("check_land_use", "Dry-run the code checks on a candidate LandUseProposal. Saves nothing.", dry)
    return run_agent("use_code_mapper", key, fips, [check], LandUseProposal,
                     _message(registry.county(fips), fips, field, codes), model=model, search=search)


def ensure_land_use(fips: str, box, *, model=None, search=None) -> dict:
    c = registry.county(fips)
    parcels = c["parcels"]
    counts = observed_codes(parcels, box)
    field = preferred_field(parcels)
    key = f"land_use-{fips}"
    res = _propose(fips, key, field, counts[field], counts, parcels, model, search)
    if res is None:
        return {}
    ok, problems, section = verify(res, counts, parcels)
    if not ok:
        log_reject(key, "use_code_mapper", res, problems)
        forget("use_code_mapper", key)
        return {}
    c = registry.county(fips)
    c["land_use"] = stamp("agent_verified", model, **section)
    registry.save_county(fips, c)
    return c["land_use"]


def extend(fips: str, codes_with_counts: Counter, *, model=None, search=None) -> int:
    """Map codes missing from an agent-verified map (a drawn area found new ones). New keys only; existing entries
    never change. Returns the number of codes added."""
    c = registry.county(fips)
    lu, parcels = c.get("land_use") or {}, c["parcels"]
    if registry.section_status(lu) == "reviewed":
        return 0
    missing = Counter({k: n for k, n in codes_with_counts.items() if k not in lu.get("map", {})})
    if not missing:
        return 0
    counts = {"raw_use": Counter(), "raw_use_desc": Counter(), lu["field"]: missing}
    key = f"land_use-{fips}-extend-{len(lu.get('map', {}))}"
    res = _propose(fips, key, lu["field"], missing, counts, parcels, model, search)
    if res is None:
        return 0
    res.field = lu["field"]
    ok, problems, _ = verify(res, counts, parcels)
    if not ok:
        log_reject(key, "use_code_mapper", res, problems)
        forget("use_code_mapper", key)
        return 0
    c = registry.county(fips)
    new = {k: v for k, v in res.map.items() if k in missing and k not in c["land_use"]["map"]}
    c["land_use"]["map"].update(new)
    c["land_use"]["verified_at"] = stamp("agent_verified", model)["verified_at"]
    registry.save_county(fips, c)
    return len(new)
