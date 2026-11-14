"""Agent 7: assessor-card scout. Finds the county's public property-card page for a sample parcel (and its URL
pattern), so the building researcher can prefer that host; optionally finds an official statement that the state does
not disclose sale prices. Code checks the card names the parcel id and its address before anything is written."""
import re

from backend.onboard import registry
from backend.onboard.arcgis import arcgis_query
from backend.onboard.common import check_tool, forget, llm_ready, log_reject, run_agent, sample_box, stamp, thresholds
from backend.onboard.parcels import normalize
from backend.onboard.zoning import official, quote_on_page
from backend.research import pages
from backend.research.verify import address_parts


def _alnum(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", pages.normalize(s))


def sample_parcels(fips: str, n: int = 3) -> list[dict]:
    """n parcels with an id and a street address near the county's sample point."""
    c = registry.county(fips)
    p = c["parcels"]
    box = sample_box(*c["sample_lonlat"], thresholds()["onboard_sample_box_m"])
    feats = arcgis_query(p["url"], box, p.get("where", "1=1"), geometry=False, max_features=100, page=100,
                         order_by=p.get("oid_field", "OBJECTID"))
    out = []
    for f in feats:
        row = normalize(p["fields"], f.get("properties") or {})
        if row["id"] not in ("None", "") and address_parts(row["address"]):
            out.append({"id": row["id"], "address": row["address"]})
        if len(out) == n:
            break
    return out


def verify(proposal, samples: list[dict], state: dict) -> tuple[bool, list[str], dict]:
    """(ok, problems, {card: section, policy: state policy update or None})."""
    problems, out = [], {"card": None, "policy": None}
    if proposal.card_url:
        sample = next((s for s in samples if _alnum(s["id"]) == _alnum(proposal.parcel_id or "")), None)
        page = pages.cached_page(proposal.card_url)
        if sample is None:
            problems.append(f"parcel_id must be one of the sample parcels: {[s['id'] for s in samples]}")
        elif page is None:
            problems.append("card_url was not fetched (fetch it with fetch_page)")
        else:
            text = pages.normalize(page.full)
            number, core = address_parts(sample["address"])
            if _alnum(sample["id"]) not in _alnum(page.full):
                problems.append(f"parcel id {sample['id']} is not on the card page")
            if not re.search(rf"(?<!\d){number}(?!\d)", text) or not re.search(rf"\b{re.escape(core[0])}\b", text):
                problems.append(f"the card page does not show the address {sample['address']}")
        if not problems:
            pattern = proposal.url_pattern if (proposal.url_pattern and "{parcel_id}" in proposal.url_pattern and
                                               proposal.url_pattern.format(parcel_id=proposal.parcel_id)
                                               == proposal.card_url) else None
            out["card"] = {"url_pattern": pattern, "example_url": proposal.card_url}
    if proposal.non_disclosure:
        q = proposal.non_disclosure_quote or ""
        url = proposal.non_disclosure_url or ""
        if not url or pages.cached_page(url) is None:
            problems.append("non_disclosure_url was not fetched")
        elif not official(url):
            problems.append("non_disclosure_url is not an official site")
        elif not quote_on_page(url, q):
            problems.append("non_disclosure_quote is not on the page")
        elif "disclos" not in q.lower() or state["name"].lower() not in q.lower():
            problems.append(f"non_disclosure_quote must mention disclosure and {state['name']}")
        else:
            out["policy"] = {"url": url, "quote": q}
    return not problems, problems, out


def ensure(fips: str, *, model=None, search=None) -> dict:
    """Write county.research.assessor_card (and a state non-disclosure policy when proven). Needs parcels."""
    from backend.schemas import AssessorProposal
    c = registry.county(fips)
    if registry.section_status(c.get("parcels")) in (None, "not_found"):
        return {}
    st = registry.state(fips[:2])
    samples = sample_parcels(fips)
    key = f"assessor-{fips}"

    def dry(p: dict) -> list[str]:
        return verify(AssessorProposal.model_validate(p), samples, st)[1]
    check = check_tool("check_assessor", "Dry-run the code checks on a candidate AssessorProposal. Saves nothing.", dry)
    msg = (f"County: {c.get('name')}, {st['name']} (FIPS {fips})\nSample parcels (id | address):\n"
           + "\n".join(f"{s['id']} | {s['address']}" for s in samples))
    res = run_agent("assessor_scout", key, fips, [check], AssessorProposal, msg, model=model, search=search)
    if res is None:
        return {}
    ok, problems, out = verify(res, samples, st)
    if not ok:
        log_reject(key, "assessor_scout", res, problems)
        forget("assessor_scout", key)
        return {}
    c = registry.county(fips)
    research = c.setdefault("research", {"preferred_domains": []})
    research["assessor_card"] = (stamp("agent_verified", model, **out["card"]) if out["card"] else
                                 stamp("not_found", model, url_pattern=None, example_url=None))
    registry.save_county(fips, c)
    if out["policy"]:
        s = registry.state(fips[:2])
        src = (s.get("policy_sources") or {}).get("non_disclosure") or {}
        if src.get("status") != "reviewed":
            data = {k: v for k, v in s.items() if k not in ("usps", "name")}
            data["policies"] = {**(s.get("policies") or {}), "non_disclosure": True}
            data["policy_sources"] = {**(s.get("policy_sources") or {}),
                                      "non_disclosure": stamp("agent_verified", model, **out["policy"])}
            registry.save_state(fips[:2], data)
    return research["assessor_card"]


def ensure_if_missing(fips: str) -> None:
    """Called by the building researcher: find the county's card host once, when an LLM is available."""
    c = registry.county(fips)
    if not llm_ready() or (c.get("research") or {}).get("assessor_card"):
        return
    try:
        ensure(fips)
    except Exception as e:   # the researcher still runs without a preferred card host
        print(f"assessor scout failed for {fips}: {type(e).__name__}: {str(e)[:200]}")
