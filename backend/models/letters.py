"""Outreach letters: deterministic templates filled from plan data. Pure.

No LLM writes or edits these letters. Every number in a body comes from the plan (sites, capital stacks, legal
paths) and is listed in `LetterDraft.figures`, formatted by `fmt_figure`; every legal statement is a corpus citation
of the parcel's recommended path, quoted verbatim. When the plan has nothing to write from, the draft carries a
`refusal` and no body.
"""
from typing import Literal, Optional

from backend.schemas import Citation, LegalPath, LetterDraft, Parcel, Plan, Site

LetterKind = Literal["owner_outreach", "pre_application", "funding_request"]

SIGNATURE = "Sincerely,\nTransitor planning team\n\nDRAFT — not sent."
ASK = {"joint_development": "a joint development partnership", "owner_partnership": "a partnership with you",
       "ground_lease": "a long-term ground lease", "buy": "a purchase"}
ASK_TITLE = {"joint_development": "joint development", "owner_partnership": "owner partnership",
             "ground_lease": "ground lease", "buy": "purchase"}
ASK_DETAIL = {
    "buy": "If you would consider selling, we would welcome a conversation about timing and terms.",
    "ground_lease": "A ground lease would let you keep the land while the homes are built and run under a "
                    "long-term lease.",
    "joint_development": "As a public owner, you could partner with us on a joint development of the site.",
    "owner_partnership": "Rather than a sale, we would like to explore converting the building together with you.",
}
QUOTE_CHARS = 240   # longer corpus quotes are cut at a word boundary and end in "…" (still verbatim up to the cut)


class LetterTargetNotFound(LookupError):
    """The plan has no site or parcel with this id."""


def fmt_figure(key: str, value: float) -> str:
    """How a figure appears in a letter body: dollars for *_usd keys, plain numbers otherwise."""
    if key.endswith("_usd"):
        return f"-${-value:,.0f}" if value < 0 else f"${value:,.0f}"
    return f"{int(value):,}" if float(value).is_integer() else f"{value:,.2f}".rstrip("0").rstrip(".")


def _usd(v: float) -> float:
    return float(round(v))


def draft_letter(plan: Plan, kind: LetterKind, target_id: str, f: dict) -> LetterDraft:
    """`f` is the resolved factor dict of the plan's locale (unused by the current templates).

    Raises LetterTargetNotFound when the site (owner_outreach, funding_request) or parcel (pre_application) is not
    in the plan."""
    if kind == "owner_outreach":
        return _owner_outreach(plan, target_id)
    if kind == "pre_application":
        return _pre_application(plan, target_id)
    if kind == "funding_request":
        return _funding_request(plan, target_id)
    raise ValueError(f"unknown letter kind {kind!r}")


def _refuse(kind: LetterKind, target_id: str, to: str, reason: str) -> LetterDraft:
    return LetterDraft(kind=kind, target_id=target_id, to=to, subject="", body="", citations=[], figures={},
                       refusal=reason)


def _site(plan: Plan, site_id: str) -> Site:
    s = next((x for x in plan.sites if x.id == site_id), None)
    if s is None:
        raise LetterTargetNotFound(f"site {site_id} not in plan")
    return s


def _parcel(plan: Plan, parcel_id: Optional[str]) -> Optional[Parcel]:
    return next((p for p in plan.parcels if p.id == parcel_id), None) if parcel_id else None


def _address(p: Optional[Parcel], parcel_id: Optional[str]) -> str:
    if p is not None and p.address.value:
        return p.address.value
    return f"parcel {parcel_id}" if parcel_id else "the parcel"


def _jurisdiction(plan: Plan) -> str:
    return plan.locale.jurisdiction.replace("_", " ").title()


def _owner_outreach(plan: Plan, site_id: str) -> LetterDraft:
    s = _site(plan, site_id)
    pid = s.parcel_ids[0] if s.parcel_ids else None
    p = _parcel(plan, pid)
    owner = p.owner.value if p is not None else None
    to = owner or "Property owner (not in public records)"
    deal = next((d for d in plan.deals if d.site_id == site_id), None)
    if deal is None:
        return _refuse("owner_outreach", site_id, to, "The land deal agent has no strategy for this site yet, so "
                                                      "there is nothing to ask the owner.")
    if deal.strategy == "pass":
        return _refuse("owner_outreach", site_id, to, "The land deal strategy for this site is to pass ("
                       + "; ".join(deal.reasons) + "), so no outreach letter is drafted.")
    address = _address(p, pid)
    figures = {"homes": float(s.homes)}
    building = next((b for b in plan.buildings if b.id == s.building_id), None) if s.building_id else None
    if s.kind == "conversion":
        name = building.name.value if building is not None and building.name.value else None
        where = f"the building {name} at {address}" if name else f"the building at {address}"
        what = "converting the existing building to homes"
    else:
        where, what = f"the property at {address}", "building new homes"
    body = (f"Dear {owner or 'Property Owner'},\n\n"
            f"We are studying {where} for {what} near transit. Our preliminary plan shows about "
            f"{fmt_figure('homes', figures['homes'])} homes on the site. We would like to discuss "
            f"{ASK[deal.strategy]}.\n\n"
            f"{ASK_DETAIL[deal.strategy]}\n\n"
            "These figures are preliminary and come from public records and our planning model; nothing in this "
            "letter is an offer or a commitment.\n\n"
            f"{SIGNATURE}")
    return LetterDraft(kind="owner_outreach", target_id=site_id, to=to,
                       subject=f"{address}: {ASK_TITLE[deal.strategy]} inquiry, homes near transit", body=body,
                       citations=[], figures=figures, refusal=None)


def _allow_value(v) -> str:
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, (list, tuple)):
        return ", ".join(_allow_value(x) for x in v)
    if isinstance(v, (int, float)):
        return fmt_figure("", float(v))
    return str(v)


def _short(quote: str) -> str:
    if len(quote) <= QUOTE_CHARS:
        return quote
    cut = quote[:QUOTE_CHARS].rsplit(" ", 1)[0]
    return cut.rstrip(" ,;:") + "…"


def _unique(cites: list[Citation]) -> list[Citation]:
    seen, out = set(), []
    for c in cites:
        k = (c.doc_id, c.section, c.quote)
        if k not in seen:
            seen.add(k)
            out.append(c)
    return out


def _pre_application(plan: Plan, parcel_id: str) -> LetterDraft:
    p = _parcel(plan, parcel_id)
    env = next((e for e in plan.envelopes if e.parcel_id == parcel_id), None)
    if p is None and env is None:
        raise LetterTargetNotFound(f"parcel {parcel_id} not in plan")
    to = f"Planning Department, {_jurisdiction(plan)}"
    if env is None:
        return _refuse("pre_application", parcel_id, to, "No legal paths were evaluated for this parcel (not a "
                                                         "candidate site), so there is no path to ask about.")
    if not env.covered:
        return _refuse("pre_application", parcel_id, to, "The legal corpus does not cover this parcel, so there is "
                                                         "no cited path to put to the planning department.")
    path: Optional[LegalPath] = next((x for x in env.paths if x.name == env.recommended_path), None)
    if path is None or path.eligible is not True:
        return _refuse("pre_application", parcel_id, to, "No eligible legal path is recommended for this parcel.")
    cites = _unique(path.citations)
    if not cites:
        return _refuse("pre_application", parcel_id, to, f"The path “{path.name}” carries no corpus citation, so "
                                                         "there is nothing to cite in a letter.")
    address = _address(p, parcel_id)
    figures: dict[str, float] = {}
    lines = [f"To the {_jurisdiction(plan)} Planning Department,", "",
             f"We are preparing a housing proposal for {address} (parcel {parcel_id}) and request a pre-application "
             "meeting to confirm the approval path before we file.", "",
             f"Our reading of the law points to this path: {path.name}."]
    if path.homes is not None:
        figures["homes"] = float(path.homes)
        lines[-1] += f" Under it, our preliminary plan fits {fmt_figure('homes', figures['homes'])} homes on the parcel."
    if path.allows:
        lines += ["", "What we understand the path allows here:"]
        for k, v in path.allows.items():
            if isinstance(v, (int, float)) and not isinstance(v, bool):
                figures[f"allows.{k}"] = float(v)
            lines.append(f"- {k}: {_allow_value(v)}")
    lines += ["", "The provisions we rely on:"]
    for i, c in enumerate(cites, 1):
        lines.append(f"[{i}] {c.doc_id}, {c.section}: “{_short(c.quote)}”" + (f" ({c.url})" if c.url else ""))
    lines += ["", "Please let us know whether you read these provisions the same way, and which submittals the "
                  "pre-application meeting requires.", "", SIGNATURE]
    return LetterDraft(kind="pre_application", target_id=parcel_id, to=to,
                       subject=f"Pre-application inquiry: {path.name} at {address}", body="\n".join(lines),
                       citations=cites, figures=figures, refusal=None)


def _funding_request(plan: Plan, site_id: str) -> LetterDraft:
    s = _site(plan, site_id)
    to = "Housing finance agency"
    st = next((x for x in plan.stacks if x.site_id == site_id), None)
    if st is None:
        return _refuse("funding_request", site_id, to, "The funding agent has no capital stack for this site, so "
                                                       "there are no figures to put to a funder.")
    pid = s.parcel_ids[0] if s.parcel_ids else None
    address = _address(_parcel(plan, pid), pid)
    figures = {"units": float(st.units), "affordable_units": float(st.affordable_units),
               "total_cost_usd": _usd(st.total_cost_usd), "debt_usd": _usd(st.debt_usd),
               "tax_credit_equity_usd": _usd(st.tax_credit_equity_usd), "incentive_usd": _usd(st.incentive_usd),
               "investor_equity_usd": _usd(st.investor_equity_usd),
               "funding_required_usd": _usd(max(st.funding_required_usd, 0.0))}   # <= 0: it pencils
    fig = {k: fmt_figure(k, v) for k, v in figures.items()}
    plan_line = (f"We plan to convert the existing building at {address} into {fig['units']} homes"
                 if s.kind == "conversion" else f"We plan to build {fig['units']} new homes at {address}")
    lines = ["To the housing finance agency,", "",
             f"{plan_line} near transit, {fig['affordable_units']} of "
             "them affordable. We write to ask about funding for the site.", "",
             "Our preliminary capital stack:",
             f"- Total development cost: {fig['total_cost_usd']}",
             f"- Debt: {fig['debt_usd']}",
             f"- Tax-credit equity: {fig['tax_credit_equity_usd']}",
             f"- Incentive: {fig['incentive_usd']}",
             f"- Investor equity: {fig['investor_equity_usd']}",
             f"- Funding required: {fig['funding_required_usd']}", ""]
    if st.funding_required_usd > 0:
        per_home = st.gap_to_pencil.funding_required_per_home_usd if st.gap_to_pencil else None
        ask = f"The stack leaves {fig['funding_required_usd']} of funding required"
        if per_home is not None:
            figures["funding_required_per_home_usd"] = _usd(per_home)
            per = fmt_figure("funding_required_per_home_usd", figures["funding_required_per_home_usd"])
            ask += f", about {per} per home"
        lines.append(ask + ". We would like to know which of your programs could cover it and when the next "
                           "funding round opens.")
    else:
        lines.append("The stack closes without outside funding. We would like to confirm the tax-credit equity and "
                     "incentive assumptions with you before we apply.")
    lines += ["", "These figures are preliminary and come from our planning model; each assumption behind them has a "
                  "cited source we can share.", "", SIGNATURE]
    return LetterDraft(kind="funding_request", target_id=site_id, to=to,
                       subject=f"Funding request: {fig['units']} homes at {address}", body="\n".join(lines),
                       citations=[], figures=figures, refusal=None)
